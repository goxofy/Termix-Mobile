// C ABI for the Termix Tailscale userspace bridge (Go tsnet).
// Keep in sync with exports in main.go.

#ifndef TERMIX_TS_H
#define TERMIX_TS_H

#ifdef __cplusplus
extern "C" {
#endif

// Configure before Up. stateDir must be a writable path. Returns 0 on success.
int TermixTS_Configure(const char *authKey, const char *hostname,
                       const char *stateDir, int ephemeral);

// Join the tailnet (blocking, ~timeout inside). Returns 0 on success.
int TermixTS_Up(void);

// Listen on 127.0.0.1:<ephemeral> and forward TCP to remoteHost:remotePort over TS.
// Writes the chosen local port to *localPortOut. Returns 0 on success.
int TermixTS_StartForward(const char *remoteHost, int remotePort,
                          int *localPortOut);

int TermixTS_StopForward(const char *remoteHost, int remotePort, int localPort);
int TermixTS_StopAllForwards(void);

// 1 if Up has succeeded and the node is still open.
int TermixTS_IsUp(void);

// Comma-separated Tailscale IPs. Caller must TermixTS_FreeString.
char *TermixTS_GetIPs(void);

// Last error message. Caller must TermixTS_FreeString.
char *TermixTS_LastError(void);

int TermixTS_Close(void);

void TermixTS_FreeString(char *p);

#ifdef __cplusplus
}
#endif

#endif /* TERMIX_TS_H */
