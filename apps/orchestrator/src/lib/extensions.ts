export function extensionErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function isExtensionIncompatible(error: unknown): boolean {
  return extensionErrorMessage(error).includes('extension_incompatible')
}

export function isExtensionPathEscape(error: unknown): boolean {
  return extensionErrorMessage(error).includes('path_escape')
}

export function isExtensionMalformed(error: unknown): boolean {
  return extensionErrorMessage(error).includes('openvsx_malformed')
}

export function isExtensionTooLarge(error: unknown): boolean {
  return extensionErrorMessage(error).includes('openvsx_too_large')
}
