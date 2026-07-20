export const SESSION_COOKIE = "okazu_session";

export function validSessionId(value: string | null | undefined) {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export function sessionFromCookieHeader(header: string | null) {
  if (!header) return null;
  const item = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return validSessionId(item ? decodeURIComponent(item.slice(SESSION_COOKIE.length + 1)) : null);
}
