export const getDoStub = env => {
  const oidcDoId = env.DO_STREAMDECK.idFromName('global')
  return env.DO_STREAMDECK.get(oidcDoId)
}
