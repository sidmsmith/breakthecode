/** In-memory Ably capture for lobby scenario tests (set BC_ABLY_MOCK=1). */
const mockMessages = [];

export function getAblyMockMessages() {
  return mockMessages.slice();
}

export function clearAblyMockMessages() {
  mockMessages.length = 0;
}

export async function ablyPublish(channel, eventName, data) {
  if (process.env.BC_ABLY_MOCK === "1") {
    mockMessages.push({
      channel,
      name: eventName,
      data: typeof data === "string" ? data : { ...data },
      at: Date.now(),
    });
    return true;
  }

  const key = process.env.ABLY_API_KEY;
  if (!key) return false;
  try {
    const res = await fetch(`https://rest.ably.io/channels/${encodeURIComponent(channel)}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(key).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: eventName, data: JSON.stringify(data) }),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

export const LOBBY_CHANNEL = "bc-lobby";

export function roomChannel(roomId) {
  return `bc-room-${roomId}`;
}
