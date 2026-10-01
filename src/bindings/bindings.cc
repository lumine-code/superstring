#include "addon-data.h"
#include "marker-index-wrapper.h"
#include "patch-wrapper.h"
#include "range-wrapper.h"
#include "text-writer.h"
#include "text-reader.h"
#include "text-buffer-wrapper.h"
#include "text-buffer-snapshot-wrapper.h"

#if defined(_WIN32) && defined(_DEBUG)
#include <crtdbg.h>
#include <cstdlib>
#include <windows.h>
#endif

using namespace Napi;

Object Init(Env env, Object exports) {
#if defined(_WIN32) && defined(_DEBUG)
  // A failed checked iterator must terminate the test process with a useful
  // diagnostic instead of blocking unattended tests on a runtime dialog.
  wchar_t report_to_stderr[2];
  if (GetEnvironmentVariableW(L"SUPERSTRING_TEST_FAILURES_TO_STDERR", report_to_stderr, 2) == 1 &&
      report_to_stderr[0] == L'1') {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
    _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
    _CrtSetReportMode(_CRT_ERROR, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ERROR, _CRTDBG_FILE_STDERR);
  }
#endif
  auto* data = new AddonData(env);
  env.SetInstanceData(data);

  PatchWrapper::init(env, exports);
  MarkerIndexWrapper::init(env, exports);
  TextBufferWrapper::init(env, exports);
  TextWriter::init(env, exports);
  TextReader::init(env, exports);
  TextBufferSnapshotWrapper::init(env);
  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
