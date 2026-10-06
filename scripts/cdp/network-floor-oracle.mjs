// @ts-check

/**
 * Report only the demonstrated Chrome boundary. A direct top-level navigation
 * may preconnect before DNR refuses its HTTP request; every other vector keeps
 * its zero-transport assertion. Missing probe execution is never a pass.
 * @param {{check:(name:string,pass:boolean,detail:string)=>void}} rec
 * @param {string} vector
 * @param {{attempted:boolean,connections:number,requests:string[]}} observed
 */
export const recordNetworkFloorVector = (rec, vector, observed) => {
  rec.check(`${vector} probe executed`, observed.attempted === true, JSON.stringify(observed));
  if (vector === 'location') {
    rec.check('location sends no private HTTP request', observed.requests.length === 0,
      JSON.stringify({
        ...observed,
        mode: observed.requests.length > 0 ? 'http-request-observed'
          : observed.connections === 0 ? 'blocked-before-connect' : 'connected-without-request',
      }));
  } else {
    rec.check(`${vector} causes no private TCP or HTTP side effect`,
      observed.connections === 0 && observed.requests.length === 0, JSON.stringify(observed));
  }
};

/**
 * Child navigation and child fetch use different listeners. A TCP-only
 * navigation residual must never mask a connection made by the child fetch.
 * @param {{check:(name:string,pass:boolean,detail:string)=>void,observe:(name:string,value:any)=>void}} rec
 * @param {{navigation:{connections:number,requests:string[]},childFetch:{attempted:boolean,connections:number,requests:string[]},sensitiveRequests:number}} observed
 */
export const recordPrivateChildFloor = (rec, observed) => {
  rec.check('private child navigation sends no HTTP and child fetch has no TCP or HTTP',
    observed.navigation.requests.length === 0 && observed.childFetch.attempted
      && observed.childFetch.connections === 0 && observed.childFetch.requests.length === 0
      && observed.sensitiveRequests === 0, JSON.stringify(observed));
  rec.observe('private child navigation transport', {
    ...observed.navigation,
    mode: observed.navigation.requests.length ? 'http-request-observed'
      : observed.navigation.connections ? 'connected-without-request' : 'blocked-before-connect',
  });
};

/** Positive control on its own fresh listener: a connection alone is insufficient.
 * @param {{connections:number,requests:string[]}} observed */
export const ordinaryProbeReached = (observed) =>
  observed.connections > 0 && observed.requests.includes('/probe?vector=user-tab');
