// Keep all application imports behind the storage boundary. In particular,
// src/services/api imports valveCommandHold, which restores session holds.
class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {return this.values.size;}
  clear() {this.values.clear();}
  getItem(key: string) {return this.values.get(String(key)) ?? null;}
  key(index: number) {return [...this.values.keys()][index] ?? null;}
  removeItem(key: string) {this.values.delete(String(key));}
  setItem(key: string, value: string) {this.values.set(String(key), String(value));}
}

Object.defineProperty(window, 'localStorage', {value: new MemoryStorage()});
Object.defineProperty(window, 'sessionStorage', {value: new MemoryStorage()});
void import('./runtime');
