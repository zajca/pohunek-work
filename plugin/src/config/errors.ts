// Configuration failure naming the file and the key; the message never carries
// the offending value, only what was expected.
export class ConfigError extends Error {
  readonly file: string;
  readonly key: string;

  constructor(file: string, key: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.file = file;
    this.key = key;
  }
}
