export class ProviderRegistry<T extends { name: string }> {
  private items = new Map<string, T>();

  register(provider: T): void {
    this.items.set(provider.name, provider);
  }

  get(name: string): T | undefined {
    return this.items.get(name);
  }

  all(): T[] {
    return [...this.items.values()];
  }

  get size(): number {
    return this.items.size;
  }
}
