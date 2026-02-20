let runtimeAdminKey = '';

export function setRuntimeAdminKey(value: string | null | undefined) {
  runtimeAdminKey = String(value ?? '').trim();
}

export function getRuntimeAdminKey() {
  return runtimeAdminKey;
}

