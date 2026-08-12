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
  export interface ModalAction {
    name: string;
    label?: string;
  }

  export interface ModalOptions {
    actions?: Record<string, ModalAction>;
    size?: unknown;
    color?: string;
    icon?: string;
  }

  /** Resolves with the id of the action the user chose; rejects when they dismissed it instead. */
  export const modal: {
    message(title: string, message: string, options?: ModalOptions): Promise<string>;
    custom(
      title: string,
      componentName: string,
      componentProps: Record<string, unknown>,
      options?: ModalOptions,
    ): Promise<string>;
    yesNo(title: string, message: string, options?: ModalOptions): Promise<string>;
    isInstalled(): boolean;
  };
}
