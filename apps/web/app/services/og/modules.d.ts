// Workers module types (see @cloudflare/vite-plugin moduleRules): .wasm → CompiledWasm, .bin → Data.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}
