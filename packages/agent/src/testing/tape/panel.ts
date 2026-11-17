/**
 * 播放控制面板。
 *
 * 一个静态页面，只做一件事：显示位置，给三个按钮。它属于测试设施，所以不参与
 * 应用构建，也不碰 `packages/ui`。
 */
export const PANEL_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>tape</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      body {
        margin: 0;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      h1 {
        font-size: 13px;
        font-weight: 600;
        margin: 0;
        opacity: 0.6;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      pre {
        margin: 0;
        font-size: 13px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-all;
      }
      .row {
        display: flex;
        gap: 8px;
      }
      button {
        flex: 1;
        font: inherit;
        font-size: 13px;
        padding: 8px 12px;
        border-radius: 6px;
        border: 1px solid currentColor;
        background: transparent;
        color: inherit;
        cursor: pointer;
      }
      button:hover {
        opacity: 0.7;
      }
    </style>
  </head>
  <body>
    <h1>tape</h1>
    <pre id="state">loading…</pre>
    <div class="row">
      <button data-action="hold">hold</button>
      <button data-action="step">step</button>
      <button data-action="resume">resume</button>
      <button data-action="takeover">takeover</button>
    </div>
    <script>
      const stateEl = document.getElementById("state");

      const render = async () => {
        const response = await fetch("/__tape/state");
        if (!response.ok) {
          stateEl.textContent = "no tape";
          return;
        }
        const state = await response.json();
        stateEl.textContent = [
          "tape      " + state.tape,
          "position  " + state.position + " / " + (state.position + state.remaining),
          "frames    " + state.frames,
          "mode      " + state.mode,
        ].join("\\n");
      };

      for (const button of document.querySelectorAll("button")) {
        button.addEventListener("click", async () => {
          await fetch("/__tape/" + button.dataset.action, { method: "POST" });
          await render();
        });
      }

      await render();
      setInterval(render, 400);
    </script>
  </body>
</html>
`;
