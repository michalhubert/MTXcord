import {
  deleteDiscordWebhookMessageId,
  getDiscordWebhookMessageId,
  setDiscordWebhookMessageId,
} from "./db";

const COLOR_ONLINE = 0xed4245; // Discord "red" - matches a live indicator
const COLOR_OFFLINE = 0x747f8d; // Discord "gray" - neutral/idle

// Resolves the webhook URL for a path from DISCORD_WEBHOOK_URLS
// (format: "path1:url1,path2:url2"), falling back to DISCORD_WEBHOOK_URL.
// Mirrors hooks/stream-online.sh's resolve_webhook_url().
function resolveWebhookUrl(path: string): string | null {
  const perPath = process.env.DISCORD_WEBHOOK_URLS || "";
  for (const rawEntry of perPath.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const sep = entry.indexOf(":");
    if (sep === -1) continue;
    const entryPath = entry.slice(0, sep).trim();
    const entryUrl = entry.slice(sep + 1).trim();
    if (entryPath === path && entryUrl) return entryUrl;
  }
  return process.env.DISCORD_WEBHOOK_URL || null;
}

function buildPlayerUrl(path: string): string | null {
  const domain = process.env.PLAYER_DOMAIN;
  if (!domain) return null;
  return `https://${domain}/${path}/`;
}

function buildEmbed(path: string, online: boolean) {
  const playerUrl = buildPlayerUrl(path);
  return {
    title: online ? "🔴 Stream is LIVE" : "⚫ Stream ended",
    description: online
      ? playerUrl
        ? `**${path}** just went live!\n[Watch now](${playerUrl})`
        : `**${path}** just went live!`
      : `**${path}** is currently offline.`,
    color: online ? COLOR_ONLINE : COLOR_OFFLINE,
    timestamp: new Date().toISOString(),
    footer: { text: path },
  };
}

async function postNewMessage(webhookUrl: string, embed: unknown): Promise<string | null> {
  try {
    const res = await fetch(`${webhookUrl}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) {
      console.error("Discord webhook POST failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = (await res.json().catch(() => null)) as { id?: string } | null;
    return data?.id ?? null;
  } catch (err) {
    console.error("Discord webhook POST errored:", err);
    return null;
  }
}

async function editMessage(webhookUrl: string, messageId: string, embed: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${webhookUrl}/messages/${messageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    return res.ok;
  } catch (err) {
    console.error("Discord webhook PATCH errored:", err);
    return false;
  }
}

// Keeps a single Discord message per path up to date with the stream's
// online/offline state, editing it in place instead of posting a new
// message every time the stream starts.
export async function syncDiscordWebhookMessage(path: string, online: boolean): Promise<void> {
  const webhookUrl = resolveWebhookUrl(path);
  if (!webhookUrl) return;

  const embed = buildEmbed(path, online);
  const existingId = getDiscordWebhookMessageId(path);

  if (existingId) {
    if (await editMessage(webhookUrl, existingId, embed)) return;
    // The message may have been deleted manually, or the webhook URL now
    // points elsewhere - drop the stale id and fall through to post fresh.
    deleteDiscordWebhookMessageId(path);
  }

  // Don't create a brand new message just to announce "offline" if we never
  // had an online message to begin with.
  if (!online) return;

  const newId = await postNewMessage(webhookUrl, embed);
  if (newId) setDiscordWebhookMessageId(path, newId);
}
