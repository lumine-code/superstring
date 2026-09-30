// Because this file is slow to compile, we separate it from patch_test.cc
// for a faster feedback loop

#define CATCH_CONFIG_MAIN
#include <catch_amalgamated.hpp>

#ifdef _WIN32
#include <crtdbg.h>
#include <cstdlib>
#include <windows.h>

namespace {
// Keep failed command-line diagnostics in stderr and the exit status instead
// of blocking the runner (or the user's desktop) on a Windows runtime dialog.
struct ConsoleFailureReports {
  ConsoleFailureReports() {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
#ifdef _DEBUG
    _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
    _CrtSetReportMode(_CRT_ERROR, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ERROR, _CRTDBG_FILE_STDERR);
#endif
  }
} console_failure_reports;
}
#endif
