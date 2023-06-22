import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import Router from '@koa/router';
import otel from '@opentelemetry/api';
import Koa from 'koa';
import { oas, Oas, RequestValidationError, ResponseValidationError } from 'koa-oas3';
import { AddressInfo } from 'net';
import { dirname } from 'path';
import { ProblemDocument, ProblemDocumentExtension } from 'http-problem-details';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

const __dirname = dirname(__filename);

const app = new Koa<unknown, { oas: Oas, docClient: DynamoDBDocumentClient }>();
const router = new Router();

// a client can be shared by different commands.
const ddbhost = process.env.DYNAMODBHOST || 'localhost:8000'; 
const client = new DynamoDBClient({
  region: "localhost",
  endpoint: `http://${ddbhost}`,
  credentials: {
    accessKeyId: "fakeMyKeyId",
    secretAccessKey: "fakeSecretAccessKey",
  }
});
const tableName = 'sample-koa';

app.context.docClient = DynamoDBDocumentClient.from(client);

type Data = {
  content: string;
};

router.head('/health', (ctx) => {
  ctx.status = 200;
});

router.get('/health', (ctx) => {
  ctx.status = 200;
});

router.put('/data/:id', async (ctx) => {
  try {
    const id = ctx.params.id;
    const content = (ctx.request.body as Data).content;
    const metricsBucket = id[0]; // 16-bucket counter based on the first character of the UUID identifier.
    otel.metrics.getMeter('sample-koa').createCounter(metricsBucket).add(1);
    await ctx.docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          id,
          content,
        },
        ConditionExpression: 'attribute_not_exists(id)'
      })
    );
    otel.diag.info('Inserted %s on id %s', content, id);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      ctx.body = new ProblemDocument({
        type: 'http://localhost/data/already-exists',
        title: 'Data with requested identifier already exists in database',
        detail: 'There is data in the database with the desired identifier',
        instance: `/data/${ctx.params.id}`,
        status: 409
      });
      ctx.response.type = 'application/problem+json';
      ctx.throw(409);
    } else {
      throw err;
    }
  }
  ctx.status = 201;
});

router.delete('/data/:id', async (ctx) => {
  await ctx.docClient.send(
    new DeleteCommand({
      TableName: tableName,
      Key: {
        id: ctx.params.id
      }
    })
  );
  ctx.status = 204;
});

router.get('/data/:id', async (ctx) => {
  const data = await ctx.docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        id: ctx.params.id
      }
    })
  );
  if (data.Item) {
    ctx.body = {
      id: ctx.params.id,
      content: data.Item.content,
    }
    ctx.status = 200;
  } else {
    ctx.body = new ProblemDocument({
      type: 'http://localhost/data/not-found',
      title: 'Data with requested identifier not found in database',
      detail: 'The data could not be found in the database',
      instance: `/data/${ctx.params.id}`,
      status: 404
    });
    ctx.response.type = 'application/problem+json';
    ctx.status = 404;
  }
});

const openAPIErrorHandler = (err: Error, ctx: Koa.Context) => {
  if (err instanceof RequestValidationError) {
    const problem = new ProblemDocument({
      type: 'http://localhost/parser-error',
      title: 'Unable to parse request',
      detail: 'Request does not comply with the specification',
      instance: ctx.params?.id ? `/data/${ctx.params.id}` : undefined,
      status: 400
    }, new ProblemDocumentExtension(err.toJSON()));
    ctx.response.type = 'application/problem+json';
    ctx.status = 400;
    ctx.res.end(JSON.stringify(problem));
    throw new Error();
  }
  if (err instanceof ResponseValidationError) {
    const problem = new ProblemDocument({
      type: 'http://localhost/parser-error',
      title: 'Unable to parse response',
      detail: 'Response does not comply with the specification',
      instance: ctx.params?.id ? `/data/${ctx.params.id}` : undefined,
      status: 500
    }, new ProblemDocumentExtension(err.toJSON()));
    ctx.response.type = 'application/problem+json';
    ctx.status = 500;
    ctx.res.end(JSON.stringify(problem));
    throw new Error();
  }
  throw err;
};

const oasMw = await oas({
  file: `${__dirname}/../openapi.yaml`,
  endpoint: '/openapi.json',
  enableUi: false,
  uiEndpoint: '/api',
  validateResponse: true,
  validatePaths: ['/data'],
  errorHandler: openAPIErrorHandler
});
app.use(oasMw);
app.use((ctx, next) => {
  if (ctx.oas) {
    otel.trace.getSpan(otel.context.active())?.setAttribute('operationId', ctx.oas.operationId);
  }
  return next();
});
app.use(router.routes()).use(router.allowedMethods());

const server = app.listen(8080);
server.on('listening', () => {
  const address = server.address() as AddressInfo;
  otel.diag.info(`Listening on port ${address.port}`);
});

