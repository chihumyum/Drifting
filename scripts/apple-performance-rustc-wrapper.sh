#!/bin/sh
# The current macOS 27 linker can emit a proc-macro dylib whose chained-fixup
# LINKEDIT string pool dyld rejects as misaligned. Use classic fixups only for
# host proc macros; target libraries and application link commands stay intact.

apple_performance_proc_macro=false
apple_performance_expect_crate_type=false
for apple_performance_argument in "$@"; do
  apple_performance_crate_types=''
  if [ "$apple_performance_expect_crate_type" = true ]; then
    apple_performance_crate_types=$apple_performance_argument
  fi
  case "$apple_performance_argument" in
    --crate-type=*) apple_performance_crate_types=${apple_performance_argument#--crate-type=} ;;
  esac
  case ",$apple_performance_crate_types," in
    *,proc-macro,*) apple_performance_proc_macro=true ;;
  esac
  apple_performance_expect_crate_type=false
  if [ "$apple_performance_argument" = --crate-type ]; then
    apple_performance_expect_crate_type=true
  fi
done

if [ "$apple_performance_proc_macro" = true ] && [ "$(uname -s)" = Darwin ]; then
  exec "$@" -C link-arg=-Wl,-no_fixup_chains
fi
exec "$@"
