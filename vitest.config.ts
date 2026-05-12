import { defineConfig } from 'vitest/config';

/** Backend modules validate DATABASE_URL at import time; unit tests do not connect unless they call store.init(). */
export default defineConfig({
  test: {
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgres://openwork:openwork@127.0.0.1:5432/openwork_vitest_placeholder',
    },
  },
});
