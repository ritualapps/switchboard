import { defineConfig } from 'vitest/config';

// Scope test discovery to this package's own suite. Without an explicit
// include, vitest walks the whole tree -- including any vendored sample
// repos under research/ -- and reports their unrelated specs as failures,
// painting a red CI badge for a green codebase.
export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
  },
});
