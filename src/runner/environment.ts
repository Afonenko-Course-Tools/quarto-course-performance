export function cleanEnvironment(base: Record<string, string>): Record<string, string> {
  const result = { ...base };
  for (const key of Object.keys(result)) {
    if (
      key.startsWith("COURSE_PERF_") ||
      [
        "COURSE_BUILD_TRACE",
        "QUARTO_REPORT_PERFORMANCE_METRICS",
        "QUARTO_REPORT_PERFORMANCE_METRICS_FILE",
        "QUARTO_PROFILER_OUTPUT",
        "QUARTO_COMBINED_LUA_PROFILE",
        "QUARTO_TS_PROFILE",
        "QUARTO_DENO",
        "QUARTO_PANDOC",
        "QUARTO_SHARE_PATH",
        "QUARTO_DENO_EXTRA_OPTIONS",
        "QUARTO_DENO_V8_OPTIONS",
      ].includes(key)
    ) delete result[key];
  }
  return result;
}
