/**
 * A local declaration for `@dynamicforms/vuetify-modal-form-kit`.
 *
 * The package ships `dist/index.d.ts` but its `package.json` `exports` map does not point at it, so
 * TypeScript cannot resolve the types while respecting `exports`. That is a packaging bug in that
 * library rather than something to work around by deep-importing the file: a deep import would
 * break the moment they fix it, and would bypass the export map that exists to let them move things.
 *
 * Declared here is exactly what taskwire calls, and nothing more. If the shape ever drifts, this
 * file is the one place that has to notice.
 */
declare module '@dynamicforms/vuetify-modal-form-kit' {
  import type { App, Component } from 'vue';

  export interface ModalAction {
    name: string;
    label?: string;
  }

  export interface ModalOptions {
    actions?: Record<string, ModalAction>;
    size?: unknown;
    color?: string;
    icon?: string;
    /** Components the dialog body resolves names against before the globally registered ones. */
    components?: Record<string, unknown>;
  }

  /** A dialog's promise; `close(value)` settles it with `value` and takes the dialog off screen. */
  export interface CloseablePromise<T> extends Promise<T> {
    close(value: T): void;
  }

  /** Resolves with the id of the action the user chose; rejects when they dismissed it instead. */
  export const modal: {
    message(title: string, message: string, options?: ModalOptions): CloseablePromise<string>;
    custom(
      title: string,
      componentName: string,
      componentProps: Record<string, unknown>,
      options?: ModalOptions,
    ): CloseablePromise<string>;
    yesNo(title: string, message: string, options?: ModalOptions): CloseablePromise<string>;
    isInstalled(): boolean;
  };

  /** The Vue plugin an application installs once, before anything calls `modal.*`. */
  export const DynamicFormsModalFormKit: {
    install(app: App, options?: Record<string, unknown>): void;
  };

  /** The host `modal.*` renders into. Mount it once, anywhere under the installed app. */
  export const ModalView: Component;
}
