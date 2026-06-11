const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(dispatchCollectWorkflow(env, "cron"));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "alpha-rightside-scheduler", schedule: "*/5 * * * *" });
    }
    if (url.pathname === "/trigger") {
      const key = url.searchParams.get("key") || "";
      if (env.TRIGGER_SECRET && key !== env.TRIGGER_SECRET) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      const result = await dispatchCollectWorkflow(env, "manual");
      return json(result, result.ok ? 200 : 502);
    }
    return json({ ok: false, error: "not_found" }, 404);
  }
};

async function dispatchCollectWorkflow(env, source) {
  const owner = env.GITHUB_OWNER || "xueyuanhuang";
  const repo = env.GITHUB_REPO || "alpha-rightside-monitor";
  const workflow = env.GITHUB_WORKFLOW || "collect.yml";
  const ref = env.GITHUB_REF || "main";

  if (!env.GITHUB_WORKFLOW_TOKEN) {
    return { ok: false, source, error: "missing_github_token" };
  }

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_WORKFLOW_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "alpha-rightside-scheduler",
      "x-github-api-version": "2022-11-28"
    },
    body: JSON.stringify({ ref })
  });

  if (response.status === 204) {
    return { ok: true, source, workflow, ref, dispatchedAt: new Date().toISOString() };
  }

  const body = await response.text();
  return { ok: false, source, status: response.status, error: body.slice(0, 300) };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders });
}
