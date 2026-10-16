// The desktop's shared code imports its screenshot decoder Vite's way (state/computerUse.ts);
// Metro hands it src/platform/shotWorker.ts instead.
declare module "*?worker" {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
