/** In-memory Storage API fixture: folders, pagination and injected failures. */
export class FakeStorage {
  objects = new Map<string, Set<string>>();
  lists: { bucket: string; prefix: string; offset: number }[] = [];
  removals: { bucket: string; paths: string[] }[] = [];
  listFailures = 0;
  removeFailures = 0;
  throwOnRemove = false;
  injectName: string | null = null;
  metadataError: unknown = null;
  metadataThrows = false;
  bucketIds: string[] | null = null;
  add(bucket: string, ...paths: string[]) {
    const objects = this.objects.get(bucket) ?? new Set<string>();
    paths.forEach((path) => objects.add(path));
    this.objects.set(bucket, objects);
  }
  storage = {
    listBuckets: async (options: { limit: number; offset: number }) => {
      if (this.metadataThrows) throw new Error("network unavailable");
      if (this.metadataError) return { data: null, error: this.metadataError };
      return { data: (this.bucketIds ?? [...this.objects.keys()]).sort().slice(options.offset, options.offset + options.limit).map((id) => ({ id, name: id })), error: null };
    },
    from: (bucket: string) => ({
      list: async (prefix: string, options: { limit: number; offset: number }) => {
        this.lists.push({ bucket, prefix, offset: options.offset });
        if (this.listFailures-- > 0) return { data: null, error: { message: "unavailable" } };
        if (!this.objects.has(bucket)) return { data: null, error: { status: 400, statusCode: "NoSuchBucket", message: "Bucket not found" } };
        const children = new Map<string, { name: string; id: string | null }>();
        for (const path of this.objects.get(bucket)!) {
          if (!path.startsWith(`${prefix}/`)) continue;
          const tail = path.slice(prefix.length + 1);
          const name = tail.split("/")[0];
          children.set(name, { name, id: tail.includes("/") ? null : path });
        }
        const data = [...children.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(options.offset, options.offset + options.limit);
        if (this.injectName) data.push({ name: this.injectName, id: "malicious" });
        return { data, error: null };
      },
      remove: async (paths: string[]) => {
        this.removals.push({ bucket, paths: [...paths] });
        if (this.throwOnRemove) throw new Error("transport unavailable");
        if (this.removeFailures-- > 0) return { data: null, error: { message: "unavailable" } };
        paths.forEach((path) => this.objects.get(bucket)?.delete(path));
        return { data: [], error: null };
      },
    }),
  };
}
