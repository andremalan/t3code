/** Distinguish Slack refusals, rate limits and transport failures with unknown write outcomes. */
export async function slackApi(method, params, token, fetchImpl = fetch) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null)
      body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  let response;
  try {
    response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error("Slack transport failed; outcome unknown");
  }
  if (response.status === 429) {
    const error = new Error("Slack rate limited the request");
    error.retryAfter = Math.max(1, Number(response.headers.get("retry-after")) || 1);
    throw error;
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Slack returned an unreadable response; outcome unknown");
  }
  if (!result.ok) {
    const error = new Error(`Slack refused ${method}: ${result.error || response.status}`);
    error.refused = true;
    throw error;
  }
  return result;
}

/** Require complete pagination and honor explicit rate limits before returning recovered rows. */
export async function slackPages(
  method,
  params,
  token,
  api = slackApi,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const rows = [];
  let cursor = "";
  const seen = new Set();
  do {
    if (seen.has(cursor) || seen.size >= 100)
      throw new Error(`Slack pagination did not finish: ${method}`);
    seen.add(cursor);
    let result;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await api(method, { ...params, limit: 200, ...(cursor && { cursor }) }, token);
        break;
      } catch (error) {
        if (!error.retryAfter || attempt >= 3) throw error;
        await pause(error.retryAfter * 1000);
      }
    }
    rows.push(...(result.messages || result.channels || []));
    cursor = result.response_metadata?.next_cursor || "";
    if (result.has_more && !cursor) throw new Error(`Slack returned incomplete history: ${method}`);
  } while (cursor);
  return rows;
}
