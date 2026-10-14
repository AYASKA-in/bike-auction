// Vite `?raw` imports (file contents as a string), used by test/security-headers.test.ts.
declare module "*?raw" {
  const content: string;
  export default content;
}
