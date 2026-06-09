export interface ExecutionSecretResolver {
  resolveSecret(handle: string): Promise<string>;
}

export function sanitizeSecretResolutionCause(error: unknown): { readonly name: string; readonly code?: string; readonly message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      ...('code' in error && typeof (error as { code: unknown }).code === 'string' ? { code: (error as { code: string }).code } : {}),
      message: error.message
    };
  }
  return { name: 'UnknownError', message: 'An unknown error occurred during secret resolution.' };
}
