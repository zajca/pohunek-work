// Awaits a promise that must reject and returns the error; a promise that
// resolves fails the test. Used instead of `expect(...).rejects`, whose bun
// typings return void.
export async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected the promise to reject");
}

/** Whether `path` does not exist. */
export async function absent(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
}
