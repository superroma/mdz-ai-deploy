const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateSiteName(name: string): string {
  if (!DNS_LABEL.test(name)) {
    throw new Error(
      `invalid site name "${name}": must be a DNS label ` +
        `(lowercase a-z, 0-9, hyphens; 1-63 chars; no leading/trailing hyphen)`
    );
  }
  return name;
}
