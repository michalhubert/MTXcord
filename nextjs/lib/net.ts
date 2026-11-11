// The header the reverse proxy in front of this app puts the client's IP in.
// For x-forwarded-for only the last entry is trusted: it's added by the
// closest proxy, while earlier ones come from the client. Any other header
// (e.g. cf-connecting-ip) must be overwritten by the proxy, or clients can
// pick their own IP.
const DEFAULT_HEADER = "x-forwarded-for";

function clientIpHeader(): string {
  return (process.env.CLIENT_IP_HEADER || DEFAULT_HEADER).toLowerCase();
}

/** True when CLIENT_IP_HEADER is set explicitly, i.e. the operator chose the header. */
export function clientIpHeaderConfigured(): boolean {
  return !!process.env.CLIENT_IP_HEADER;
}

export function getClientIp(req: { headers: Headers }): string {
  const header = clientIpHeader();
  const value = req.headers.get(header);
  const ip = header === DEFAULT_HEADER ? value?.split(",").at(-1) : value;
  return ip?.trim() || "unknown";
}
