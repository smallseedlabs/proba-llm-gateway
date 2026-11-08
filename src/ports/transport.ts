/**
 * HTTP transport seam. Internal Hub→gateway API. No public ingress default.
 */
export interface HttpTransport {
  listen(): Promise<void>;
  close(): Promise<void>;
}
