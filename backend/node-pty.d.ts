declare module 'node-pty' {
  export interface IPty {
    onData: (callback: (data: string) => void) => void;
    onExit: (callback: (e: { exitCode: number }) => void) => void;
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    kill: (signal?: string) => void;
  }

  export interface IWindowsPtyForkOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: { [key: string]: string | undefined };
  }

  export function spawn(
    file: string,
    args: string[],
    options: IWindowsPtyForkOptions
  ): IPty;
}