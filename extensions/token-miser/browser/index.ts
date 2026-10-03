import { defineControlUiPlugin, type ControlUiPanel } from "openclaw/plugin-sdk/control-ui";
import "./styles.css";

type TokenMiserStats = {
  scope: "gateway-runtime";
  originalBytes: number;
  projectedBytes: number;
  retrievedBytes: number;
  retrievalCount: number;
  decisions: number;
  summarized: number;
  passedThrough: number;
  failedOpen: number;
  retainedCount: number;
  helper: {
    calls: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
  };
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

const mountPanel: ControlUiPanel["mount"] = (container, initialContext) => {
  let context = initialContext;
  let disposed = false;
  let generation = 0;
  let signature = "";
  let stats: TokenMiserStats | undefined;
  let error: string | undefined;
  let loading = false;
  let refreshPending = false;
  const host = context.host;
  const panel = element("div");
  panel.className = "token-miser-panel";
  container.append(panel);

  const available = () =>
    !disposed &&
    !context.signal.aborted &&
    context.presented &&
    host.connection.connected &&
    host.connection.canRead &&
    Boolean(context.props.sessionKey);

  const draw = () => {
    if (disposed) {
      return;
    }
    const description = element(
      "p",
      "Measurements cover this session in the current Gateway runtime. Byte counts are UTF-8 sizes, not token or savings estimates. Opting into helper-model reduction can incur provider charges.",
    );
    description.className = "token-miser-panel__description";
    const refresh = element("button", loading ? "Refreshing…" : "Refresh");
    refresh.type = "button";
    refresh.disabled = !available() || loading;
    refresh.addEventListener("click", () => void read());
    const heading = element("div");
    heading.className = "token-miser-panel__heading";
    heading.append(element("h2", "Token Miser"), refresh);
    const nodes: Node[] = [heading, description];
    let message: string | undefined;
    if (!host.connection.connected) {
      message = "Connect to the Gateway to view Token Miser measurements.";
    } else if (!host.connection.canRead) {
      message = "Read access is required to view Token Miser measurements.";
    } else if (!context.props.sessionKey) {
      message = "Select a session to view Token Miser measurements.";
    } else if (error) {
      message = error;
    } else if (!stats) {
      message = loading ? "Loading measurements…" : "Measurements are not loaded.";
    } else if (stats.decisions === 0) {
      message = "No Token Miser decisions for this session in the current Gateway runtime.";
    }
    if (message) {
      const status = element("p", message);
      status.setAttribute("role", error ? "alert" : "status");
      nodes.push(status);
    }
    if (stats) {
      const rows: [string, number | undefined][] = [
        ["Original bytes", stats.originalBytes],
        ["Delivered bytes", stats.projectedBytes],
        ["Retrieval response bytes", stats.retrievedBytes],
        ["Completed retrievals", stats.retrievalCount],
        ["Retained originals", stats.retainedCount],
        ["Decisions", stats.decisions],
        ["Summarized", stats.summarized],
        ["Passed through", stats.passedThrough],
        ["Failed open", stats.failedOpen],
        ["Helper calls", stats.helper.calls],
        ["Helper input tokens", stats.helper.inputTokens],
        ["Helper output tokens", stats.helper.outputTokens],
        ["Helper cache read tokens", stats.helper.cacheReadTokens],
        ["Helper cache write tokens", stats.helper.cacheWriteTokens],
      ];
      const metrics = element("dl");
      metrics.className = "token-miser-panel__metrics";
      for (const [label, value] of rows) {
        const row = element("div");
        row.append(element("dt", label), element("dd", value?.toLocaleString() ?? "Unavailable"));
        metrics.append(row);
      }
      const cost = element("div");
      cost.append(
        element("dt", "Reported helper cost (USD)"),
        element(
          "dd",
          stats.helper.costUsd === undefined ? "Unavailable" : stats.helper.costUsd.toFixed(6),
        ),
      );
      metrics.append(cost);
      nodes.push(
        metrics,
        element(
          "p",
          "Helper tokens and cost are shown only when reported by the provider. Retrieval counters include reads consumed inside Code Mode; they do not prove parent-model delivery. Retained originals expire under the storage retention policy.",
        ),
      );
    }
    panel.replaceChildren(...nodes);
  };

  const read = async () => {
    if (!available()) {
      return;
    }
    if (loading) {
      refreshPending = true;
      return;
    }
    const current = ++generation;
    const sessionKey = context.props.sessionKey;
    loading = true;
    error = undefined;
    draw();
    try {
      const result = await host.request<TokenMiserStats>("tokenMiser.stats", { sessionKey });
      if (current === generation && available() && context.props.sessionKey === sessionKey) {
        stats = result;
      }
    } catch (cause) {
      if (current === generation && available()) {
        stats = undefined;
        error = host.redact(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (current === generation) {
        loading = false;
        draw();
        if (refreshPending) {
          refreshPending = false;
          void read();
        }
      }
    }
  };

  const synchronize = () => {
    const next = JSON.stringify([
      context.props.sessionKey,
      context.presented,
      host.connection.connected,
      host.connection.canRead,
    ]);
    if (next !== signature) {
      signature = next;
      generation++;
      stats = undefined;
      error = undefined;
      loading = false;
      refreshPending = false;
      if (available()) {
        void read();
      }
    }
    draw();
  };
  const stopHost = host.subscribe(synchronize);
  const stopEvents = host.onEvent("tokenMiser.updated", (payload) => {
    if (
      payload &&
      typeof payload === "object" &&
      "sessionKey" in payload &&
      payload.sessionKey === context.props.sessionKey
    ) {
      void read();
    }
  });
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    generation++;
    initialContext.signal.removeEventListener("abort", dispose);
    stopHost();
    stopEvents();
    panel.remove();
  };
  context.signal.addEventListener("abort", dispose, { once: true });
  synchronize();
  return {
    update(next) {
      context = next;
      synchronize();
    },
    dispose,
  };
};

export default defineControlUiPlugin({
  id: "token-miser",
  activate(host) {
    const stopPanel = host.ui.registerPanel({
      id: "measurements",
      label: "Token Miser",
      mount: mountPanel,
    });
    const stopAccessory = host.ui.registerAccessory({
      id: "measurements",
      placement: "session-header",
      mount(container, initialContext) {
        let context = initialContext;
        let disposed = false;
        const button = element("button", "Token Miser");
        button.className = "token-miser-accessory";
        button.type = "button";
        const draw = () => {
          button.hidden =
            !context.presented || !host.connection.canRead || !context.props.sessionKey;
          button.disabled = !host.connection.connected;
        };
        button.addEventListener("click", () => {
          if (
            !disposed &&
            !context.signal.aborted &&
            context.presented &&
            host.connection.connected &&
            host.connection.canRead &&
            context.props.sessionKey
          ) {
            host.ui.openPanel("measurements", {
              sessionKey: context.props.sessionKey,
              agentId: context.props.agentId,
            });
          }
        });
        container.append(button);
        const stop = host.subscribe(draw);
        const dispose = () => {
          if (disposed) {
            return;
          }
          disposed = true;
          initialContext.signal.removeEventListener("abort", dispose);
          stop();
          button.remove();
        };
        initialContext.signal.addEventListener("abort", dispose, { once: true });
        draw();
        return {
          update(next) {
            context = next;
            draw();
          },
          dispose,
        };
      },
    });
    return () => {
      stopAccessory();
      stopPanel();
    };
  },
});
