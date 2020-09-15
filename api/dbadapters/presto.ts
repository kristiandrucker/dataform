import * as Presto from "presto-client";
import * as PromisePool from "promise-pool-executor";

import { Credentials } from "df/api/commands/credentials";
import { IDbAdapter, IDbClient, IExecutionResult } from "df/api/dbadapters/index";
import { LimitedResultSet } from "df/api/utils/results";
import { flatten } from "df/common/arrays/arrays";
import { collectEvaluationQueries, QueryOrAction } from "df/core/adapters";
import { dataform } from "df/protos/ts";

interface IPrestoExecutionResult {
  columns?: Presto.IPrestoClientColumnMetaData[];
  data?: Presto.PrestoClientColumnDatum[];
  queryId?: string;
  stats?: Presto.IPrestoClientStats;
}

// TODO: Move this to somewhere both the API and CLI can use?
function resolveTarget(target: dataform.ITarget) {
  return `${target.database ? `${target.database}.` : ""}${
    target.schema ? `${target.schema}.` : ""
  }${target.name}`;
}

export class PrestoDbAdapter implements IDbAdapter {
  public static async create(credentials: Credentials, options?: { concurrencyLimit?: number }) {
    return new PrestoDbAdapter(credentials, options);
  }

  private client: Presto.Client;

  private pool: PromisePool.PromisePoolExecutor;

  private constructor(credentials: Credentials, options?: { concurrencyLimit?: number }) {
    this.client = new Presto.Client(credentials as Presto.IPrestoClientOptions);
    this.pool = new PromisePool.PromisePoolExecutor({
      concurrencyLimit: options?.concurrencyLimit || 10,
      frequencyWindow: 1000,
      frequencyLimit: 10
    });
  }

  public async execute(
    statement: string,
    // TODO: These execute options should actually allow any of Presto.IPrestoClientExecuteOptions.
    options: {
      rowLimit?: number;
      byteLimit?: number;
    } = { rowLimit: 1000, byteLimit: 1024 * 1024 }
  ): Promise<IExecutionResult> {
    let isCancelled = false;
    const prestoResult: IPrestoExecutionResult = await this.pool
      .addSingleTask({
        generator: () =>
          new Promise((resolve, reject) => {
            const result: IPrestoExecutionResult = { data: [] };
            const allRows = new LimitedResultSet({
              rowLimit: options.rowLimit,
              byteLimit: options.byteLimit
            });
            const cancelIfError = (error: Presto.IPrestoClientError) => {
              if (!!error) {
                reject(error);
                return (isCancelled = true);
              }
            };
            this.client.execute({
              query: statement,
              cancel: () => {
                // The presto client cancels executions if this returns true.
                return isCancelled;
              },
              state: (error, queryId, stats) => {
                if (cancelIfError(error)) {
                  return;
                }
                result.queryId = queryId;
                result.stats = stats;
              },
              columns: (error, columns) => {
                if (cancelIfError(error)) {
                  return;
                }
                result.columns = columns;
              },
              data: (error, data, columns, stats) => {
                if (cancelIfError(error)) {
                  return;
                }
                result.columns = columns;
                result.stats = stats;
                if (!allRows.push(data)) {
                  result.data = allRows.rows;
                  resolve(result);
                }
              },
              success: (error, stats) => {
                if (cancelIfError(error)) {
                  return;
                }
                result.stats = stats;
                resolve(result);
              },
              error: cancelIfError
            });
          })
      })
      .promise();
    return { rows: prestoResult.data, metadata: {} };
  }

  public async withClientLock<T>(callback: (client: IDbClient) => Promise<T>) {
    return await callback(this);
  }

  public async evaluate(queryOrAction: QueryOrAction, projectConfig?: dataform.ProjectConfig) {
    const useSingleQueryPerAction =
      projectConfig?.useSingleQueryPerAction === undefined ||
      !!projectConfig?.useSingleQueryPerAction;
    const validationQueries = collectEvaluationQueries(
      queryOrAction,
      useSingleQueryPerAction,
      (query: string) => (!!query ? `explain ${query}` : "")
    ).map((validationQuery, index) => ({ index, validationQuery }));
    const validationQueriesWithoutWrappers = collectEvaluationQueries(
      queryOrAction,
      useSingleQueryPerAction
    );

    const queryEvaluations = new Array<dataform.IQueryEvaluation>();
    for (const { index, validationQuery } of validationQueries) {
      let evaluationResponse: dataform.IQueryEvaluation = {
        status: dataform.QueryEvaluation.QueryEvaluationStatus.SUCCESS
      };
      try {
        await this.execute(validationQuery.query);
      } catch (e) {
        evaluationResponse = {
          status: dataform.QueryEvaluation.QueryEvaluationStatus.FAILURE,
          error: {
            message: e.message,
            errorLocation: {
              line: e.errorLocation?.lineNumber,
              column: e.errorLocation?.columnNumber
            }
          }
        };
      }
      queryEvaluations.push(
        dataform.QueryEvaluation.create({
          ...evaluationResponse,
          incremental: validationQuery.incremental,
          query: validationQueriesWithoutWrappers[index].query
        })
      );
    }
    return queryEvaluations;
  }

  public async schemas(catalog: string): Promise<string[]> {
    const result = await this.execute(`show schemas from ${catalog}`);
    return flatten(result.rows);
  }

  public async createSchema(catalog: string, schema: string): Promise<void> {
    await this.execute(`create schema if not exists ${catalog}.${schema}`);
  }

  public async tables(): Promise<dataform.ITarget[]> {
    const catalogs = await this.catalogs();
    let targets: dataform.ITarget[] = [];
    await Promise.all(
      catalogs.map(
        async catalog =>
          await Promise.all(
            (await this.schemas(catalog)).map(async targetSchema => {
              const result = await this.execute(`show tables from ${catalog}.${targetSchema}`);
              targets = targets.concat(
                flatten(result.rows).map(table =>
                  dataform.Target.create({
                    database: catalog,
                    schema: targetSchema,
                    name: table as string
                  })
                )
              );
            })
          )
      )
    );
    return targets;
  }

  public async table(target: dataform.ITarget): Promise<dataform.ITableMetadata> {
    let columnsResult: IExecutionResult;
    try {
      // TODO: In the future, the connection won't specify the catalog (database) and schema to allow
      // moving data between tables, in which case target resolution should throw if both are not present.
      columnsResult = await this.execute(`describe ${resolveTarget(target)}`);
    } catch (e) {
      throw e;
      // This probably failed because the table doesn't exist, so ignore as the information isn't necessary.
    }
    // TODO: Add primitives mapping.
    // Columns are structured [column name, type (primitive), extra, comment]. This can be
    // seen under columnsResult.columns; instead they could be dynamically populated using this info.
    const fields =
      columnsResult?.rows.map(column =>
        dataform.Field.create({ name: column[0], description: column[3] })
      ) || [];
    return dataform.TableMetadata.create({
      // TODO: Add missing table metadata items.
      target,
      fields
    });
  }

  public async preview(target: dataform.ITarget, limitRows: number = 10): Promise<any[]> {
    const { rows } = await this.execute(
      `select * from ${target.database}.${target.schema}.${target.name} limit ${limitRows}`
    );
    return rows;
  }

  public async persistedStateMetadata(): Promise<dataform.IPersistedTableMetadata[]> {
    // Unimplemented.
    return [];
  }

  public async persistStateMetadata() {
    // Unimplemented.
  }

  public async setMetadata(action: dataform.IExecutionAction): Promise<void> {
    // Unimplemented.
  }

  public async close() {
    // Unimplemented.
  }

  private async catalogs(): Promise<string[]> {
    const result = await this.execute("show catalogs");
    const catalogs: string[] = flatten(result.rows);
    return catalogs;
  }
}
