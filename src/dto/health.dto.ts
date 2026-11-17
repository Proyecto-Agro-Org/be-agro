// GetHealthRequest does not apply: no params, query or body are consumed.
// This static response type does not validate incoming HTTP at runtime.
export interface GetHealthResponse {
  status: 'ok';
}
