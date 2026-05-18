// oxlint-disable-next-line typescript/no-empty-interface typescript/no-empty-object-type
export interface CreateContextOptions {}

// oxlint-disable-next-line func-style require-await no-unused-vars no-empty-pattern
export async function createContext({}: CreateContextOptions) {
  return {};
}

export type Context = Awaited<ReturnType<typeof createContext>>;
