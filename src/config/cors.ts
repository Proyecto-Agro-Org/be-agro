export function getAllowedOrigins(value = process.env.CORS_ORIGINS ?? '') {
  return new Set(
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}
