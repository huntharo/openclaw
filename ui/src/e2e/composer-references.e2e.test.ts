import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const currentSession = "agent:main:main";
const referenceSession = "agent:main:reference-review";
const discoveryMethods = ["projects.list", "environments.list", "sessions.list"];

suite.define(() => {
  it("inserts native session, PR, project, and environment references without rediscovery or sending", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: currentSession,
          workspace: "/workspace",
          operatorScopes: ["operator.read", "operator.write", "operator.admin"],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "projects.list",
            "environments.list",
            SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          ],
          sessions: [
            {
              key: currentSession,
              displayName: "Current conversation",
              label: "Current conversation",
              kind: "direct",
              updatedAt: 2,
            },
            {
              key: referenceSession,
              displayName: "Reference review",
              label: "Reference review",
              kind: "direct",
              updatedAt: 1,
            },
          ],
          methodResponses: {
            "projects.list": {
              projects: [
                {
                  id: "reference-repo",
                  displayName: "Reference repository",
                  repoRoot: "/workspace/reference-repo",
                  source: "registered",
                },
              ],
            },
            "environments.list": {
              environments: [
                {
                  id: "node:build-machine",
                  type: "node",
                  label: "Build machine",
                  status: "unavailable",
                },
              ],
            },
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          },
        });
        const readCounts = () =>
          Promise.all(
            discoveryMethods.map(async (method) => (await gateway.getRequests(method)).length),
          );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, currentSession));
        const input = page.locator(".agent-chat__composer-combobox textarea").first();
        await input.waitFor();
        await gateway.waitForRequest("projects.list");
        await gateway.waitForRequest(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
        // Child roster hydration follows the primary roster; it is not a reference search.
        await gateway.waitForRequest("sessions.list", { match: { spawnedBy: currentSession } });
        await page
          .locator(`.sidebar-recent-session[data-session-key="${referenceSession}"]`)
          .waitFor();
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [currentSession]: {
              status: "ready",
              rateLimited: false,
              pullRequests: [
                {
                  number: 42,
                  title: "Repair reference selection",
                  owner: "example",
                  repo: "repository",
                  branch: "reference-fix",
                  state: "open",
                  url: "https://github.com/example/repository/pull/42",
                },
              ],
            },
          },
        });

        const chatCounts = await readCounts();
        await input.pressSequentially("#");
        const hashMenu = page.getByRole("listbox", { name: "Sessions and pull requests" });
        await hashMenu.getByRole("option").filter({ hasText: "#42" }).waitFor();
        await hashMenu.getByRole("option").filter({ hasText: "Reference review" }).waitFor();
        expect(
          await hashMenu.getByRole("option").filter({ hasText: "Current conversation" }).count(),
        ).toBe(0);
        await captureUiProof(suite, page, "composer-references", "chat-hash-menu.png");
        await input.press("End");
        await input.press("Tab");
        expect(await input.inputValue()).toContain(
          '(session "agent:main:reference-review", agent "main")',
        );
        expect(await input.inputValue()).toMatch(/\[#Reference review\]\(<\/chat\//u);
        await input.pressSequentially("#42");
        await hashMenu.getByRole("option").filter({ hasText: "#42" }).waitFor();
        await input.press("Enter");
        expect(await input.inputValue()).toContain(
          "[#42](<https://github.com/example/repository/pull/42>)",
        );
        await input.pressSequentially("@/");
        const projectsMenu = page.getByRole("listbox", { name: "Projects and directories" });
        await projectsMenu
          .getByRole("option")
          .filter({ hasText: "Reference repository" })
          .waitFor();
        await captureUiProof(suite, page, "composer-references", "chat-project-menu.png");
        await input.press("Enter");
        expect(await input.inputValue()).toContain(
          'Project "reference-repo" (directory "/workspace/reference-repo")',
        );
        await captureUiProof(suite, page, "composer-references", "chat-selected-references.png");
        expect(
          await readCounts(),
          JSON.stringify(await gateway.getRequests("sessions.list")),
        ).toEqual(chatCounts);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        await page.goto(`${suite.server.baseUrl}new`);
        const newInput = page.locator(".new-session-page__message");
        await newInput.waitFor();
        await gateway.waitForRequest("environments.list");
        await expect.poll(() => newInput.getAttribute("placeholder")).toContain("@: environments");
        const newCounts = await readCounts();
        await newInput.pressSequentially("@:");
        const environmentMenu = page.getByRole("listbox", { name: "Environments", exact: true });
        const environment = environmentMenu
          .getByRole("option")
          .filter({ hasText: "Build machine" });
        await environment.waitFor();
        expect(await environment.textContent()).toContain("unavailable");
        await captureUiProof(suite, page, "composer-references", "new-environment-menu.png");
        await newInput.press("Tab");
        expect(await newInput.inputValue()).toBe(
          'Environment "node:build-machine" ("Build machine") ',
        );
        await captureUiProof(suite, page, "composer-references", "new-selected-environment.png");
        expect(await readCounts()).toEqual(newCounts);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });
});
