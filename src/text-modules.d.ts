// Prompt templates are imported as text and bundled by `bun build`.
declare module "*.tmpl" {
  const text: string;
  export default text;
}
