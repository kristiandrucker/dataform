import { expect } from "chai";

import * as dfapi from "df/api";
import * as dbadapters from "df/api/dbadapters";
import { dataform } from "df/protos/ts";
import { suite, test } from "df/testing";
import { compile, keyBy } from "df/tests/integration/utils";
import { PrestoFixture, prestoTestCredentials } from "df/tools/presto/presto_fixture";

suite("@dataform/integration/presto", { parallel: true }, ({ before, after }) => {
  const _ = new PrestoFixture(1234, before, after);

  let dbadapter: dbadapters.IDbAdapter;

  before("create adapter", async () => {
    dbadapter = await dbadapters.create(prestoTestCredentials, "presto", {
      disableSslForTestsOnly: true
    });
  });

  after("close adapter", async () => dbadapter.close());

  test("run", { timeout: 60000 }, async () => {
    const compiledGraph = await compile("tests/integration/presto_project", "project_e2e");

    // Run the project.
    const executionGraph = await dfapi.build(compiledGraph, {}, dbadapter);
    const executedGraph = await dfapi.run(dbadapter, executionGraph).result();

    const actionMap = keyBy(executedGraph.actions, v => v.name);
    expect(Object.keys(actionMap).length).eql(1);

    for (const actionName of Object.keys(actionMap)) {
      expect(actionMap[actionName].status).equals(dataform.ActionResult.ExecutionStatus.SUCCESSFUL);
    }
  });
});