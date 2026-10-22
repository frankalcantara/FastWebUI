// WebUI C Example - Round-trip latency benchmark
//
// Measures both directions and prints p50 / p99 / mean in microseconds:
//   - C -> JS : webui_script()
//   - JS -> C : webui.call() of a bound function

#include "webui.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
static double now_us(void) {
    LARGE_INTEGER f, c;
    QueryPerformanceFrequency(&f);
    QueryPerformanceCounter(&c);
    return (double)c.QuadPart * 1e6 / (double)f.QuadPart;
}
#else
#include <time.h>
static double now_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1e6 + (double)ts.tv_nsec / 1e3;
}
#endif

#define WARMUP 50
#define MAX_SAMPLES 100000

static int cmp(const void* a, const void* b) {
    double x = *(const double*)a, y = *(const double*)b;
    return (x > y) - (x < y);
}

static void report(const char* name, double* s, size_t n) {
    if (n == 0)
        return;
    double sum = 0;
    for (size_t i = 0; i < n; i++)
        sum += s[i];
    qsort(s, n, sizeof(double), cmp);
    printf("%-22s n=%-6zu p50=%9.1f us  p99=%9.1f us  mean=%9.1f us\n",
        name, n, s[n / 2], s[(size_t)((double)n * 0.99)], sum / (double)n);
}

static size_t js_to_c_count = 0;
static double js_to_c_start = 0;
static double js_to_c_total = 0;

// Bound function, called by JS in a loop
static void ping(webui_event_t* e) {
    js_to_c_count++;
    webui_return_int(e, (long long)js_to_c_count);
}

// JS reports the whole loop duration once finished
static void js_loop_done(webui_event_t* e) {
    (void)e;
    js_to_c_total = now_us() - js_to_c_start;
}

int main(int argc, char** argv) {
    size_t iterations = (argc > 1) ? (size_t)atoi(argv[1]) : 1000;
    if (iterations < 1 || iterations > MAX_SAMPLES)
        iterations = 1000;

    size_t win = webui_new_window();
    webui_bind(win, "ping", ping);
    webui_bind(win, "js_loop_done", js_loop_done);
    webui_set_config(show_wait_connection, true);

    if (!webui_show(win, "<html><head><script src=\"webui.js\"></script></head>"
        "<body>WebUI latency benchmark</body></html>")) {
        printf("Failed to open a browser window.\n");
        return 1;
    }

    static double samples[MAX_SAMPLES];
    char buf[64];

    // C -> JS
    for (size_t i = 0; i < WARMUP; i++)
        webui_script(win, "return 1;", 10, buf, sizeof(buf));
    size_t ok = 0;
    for (size_t i = 0; i < iterations; i++) {
        double t = now_us();
        if (webui_script(win, "return 1;", 10, buf, sizeof(buf)))
            samples[ok++] = now_us() - t;
    }
    report("C -> JS webui_script", samples, ok);

    // JS -> C
    char script[256];
    snprintf(script, sizeof(script),
        "(async () => { for (let i = 0; i < %zu; i++) await webui.call('ping'); "
        "await webui.call('js_loop_done'); })();", iterations);
    js_to_c_start = now_us();
    webui_run(win, script);
    for (int i = 0; i < 600 && js_to_c_total == 0; i++) {
        #ifdef _WIN32
        Sleep(100);
        #else
        struct timespec ts = {0, 100000000L};
        nanosleep(&ts, NULL);
        #endif
    }
    if (js_to_c_total > 0)
        printf("%-22s n=%-6zu mean=%9.1f us\n", "JS -> C webui.call", js_to_c_count,
            js_to_c_total / (double)js_to_c_count);
    else
        printf("JS -> C benchmark timed out.\n");

    webui_exit();
    return 0;
}
