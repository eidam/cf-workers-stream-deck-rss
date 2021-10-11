declare global {
    interface DurableObjectState {
        blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
    }
}

export interface Env {}
