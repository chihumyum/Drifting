#ifndef DRIFTING_LAB_H
#define DRIFTING_LAB_H
// ABI v1. All returned JSON strings are owned by Rust and freed exactly once.
// Call on a background serial queue. No credentials or production databases.
char *drifting_lab_call(const char *input);
void drifting_lab_free(char *value);
#endif
