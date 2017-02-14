/**
 * @license ng-facade
 * (c) 2017 Jason Bedard
 * License: MIT
 */

import "reflect-metadata";
import {module} from "angular";

/* TODO...
    - @Output (https://github.com/angular/angular/blob/2.4.5/modules/%40angular/core/src/metadata/directives.ts#L886)
    - component lifecycle interfaces: https://angular.io/docs/ts/latest/guide/lifecycle-hooks.html ?
    - @Optional, @Self, @SkipSelf, @Host
    - @ViewChild ?
    - @HostListener ? (https://github.com/angular/angular/blob/2.4.5/modules/%40angular/core/src/metadata/directives.ts#L1005)
    - ElementRef ? (https://github.com/angular/angular/blob/2.4.5/modules/%40angular/core/src/linker/element_ref.ts#L24)
*/


const Type = Function;
export interface Type<T> extends Function { new (...args: any[]): T; }


type Injectable<T extends Function> = T | Array<string | T>;


let tid = 0;
function getTypeName(type): string {
    if (type.$$injectable) {
        type = type.$$name || (type.$$name = type.name + (window["angular"].mock ? "" : `_${tid++}`));
    }

    return type;
}

function getModuleName(mod/*: string | angular.IModule | Type<any>*/): string {
    return mod.$$module || mod.name || mod;
}

function getInjectArray(target: Injectable<any>): any[] {
    return target.$inject || (target.$inject = <string[]>(target.$inject || []));
}

function dashToCamel(s: string): string {
    return s.replace(/-([a-z])/g, (a, letter) => letter.toUpperCase());
}


/**
 * Build the AngularJS style `$inject` array for the passed object, converting Angular style to AngularJS.
 *
 * Supports:
 *    - AngularJS style `['InjectedName', InjectedClass, methodFoo]` or `methodFoo.$inject = ['InjectedName', InjectedClass]`
 *    - Angular style `@Injectable() class Foo { constructor(@Inject("InjectedName") localName){} }`
 *    - Angular style `@Injectable() class Foo { constructor(private localName: InjectedClass){} }`
 *    - any mix of the above
 */
function injectMethod<T extends Injectable<any>>(method: T) {
    //Array<string | Type> => Array<string>
    if (Array.isArray(method)) {
        for (let i=0; i<method.length-1; i++) {
            if (typeof method[i] !== "string") {
                method[i] = getTypeName(method[i]);
            }
        }
        return method;
    }

    //@Injectable() (or any annotation?)
    //Extract the object types via TypeScript metadata
    const paramTypes: Array<Type<any>> = Reflect.getMetadata("design:paramtypes", method);
    if (paramTypes) {
        const $inject = getInjectArray(method);

        for (let i=0; i<paramTypes.length; i++) {
            //Try to extract types via TypeScript if currently unknown
            if (undefined === $inject[i]) {
                $inject[i] = paramTypes[i];
            }
        }
    }

    //Types extracted from TypeScript or specificed manually in $inject
    const $inject = method.$inject;
    if ($inject) {
        for (let i=0; i<$inject.length; i++) {
            //Convert type => string for injection via types
            if ($inject[i].$$injectable) {
                $inject[i] = getTypeName($inject[i]);
            }
        }
    }

    return method;
}

function setupProvider(mod: angular.IModule, provider/*: Provider | PipeTransform*/): void {
    if (provider.multi) {
        throw new Error("Provider.multi unsupported");
    }

    //Provider type detection similar to:
    // https://github.com/angular/angular/blob/2.4.4/modules/%40angular/core/src/di/reflective_provider.ts#L103
    // +
    // https://github.com/angular/angular/blob/2.4.4/modules/%40angular/core/src/di/reflective_provider.ts#L181

    //PipeTransform
    if (provider.$$pipe) {
        mod.filter(provider.$$pipe.name, ["$injector", function($injector) {
            const pipe = $injector.instantiate(provider);
            const transform = pipe.transform.bind(provider);
            transform.$stateful = (false === provider.$$pipe.pure);
            return transform;
        }]);
    }
    //ExistingProvider
    else if (provider.useExisting) {
        const existingName = provider.useExisting;
        mod.factory(getTypeName(provider.provide), ["$injector", function($injector) {
            return $injector.get(existingName);
        }]);
    }
    //FactoryProvider
    else if (provider.useFactory) {
        mod.factory(getTypeName(provider.provide), provider.useFactory);
    }
    //ClassProvider
    else if (provider.useClass) {
        setupProvider(mod, provider.useClass);
        setupProvider(mod, {provide: provider.provide, useExisting: provider.useClass});
    }
    //TypeProvider
    else if (provider instanceof Type) {
        mod.service(getTypeName(provider), provider);
    }
    //any[], ...
    else {
        throw new Error(`Unsupported provider: ${typeof provider}`);
    }
}

function setupComponent(mod: angular.IModule, ctrl: Type<any>, decl: Component): void {
    const bindings = {};

    //@Input(Type)s
    ((<any>ctrl).$$inputs || []).forEach(function(input: InternalInputMetadata) {
        bindings[input.name] = input.type + "?" + (input.publicName || "");
    });

    //inputs[]
    (decl.inputs || []).forEach(function(input) {
        const [name, publicName] = input.split(":").map((s) => s.trim());
        bindings[name] = `<?${publicName || ""}`;
    });

    //@Require()s
    const require = ((<any>ctrl).$$require);

    mod.component(dashToCamel(decl.selector), {
        template: decl.template,
        bindings,
        require,
        controller: ctrl,
        controllerAs: decl.controllerAs,
        transclude: decl.transclude
    });
}

function setupDirective(mod: angular.IModule, ctrl: Type<any>, decl: Directive): void {
    //Element vs attribute
    //AngularJS does not support complex selectors
    //Angular does not support comments
    //this library does not support class
    let name = decl.selector;
    let restrict = "E";
    if (name[0] === "[" && name[name.length-1] === "]") {
        name = name.slice(1, name.length-1);
        restrict = "A";
    }
    else if (name[0] === ".") {
        name = name.slice(1);
        restrict = "C";
    }

    //TODO: inputs on Directive which has no isolated scope?
    if (decl.inputs || (<any>ctrl).$$inputs) {
        throw new Error("Directive inputs unsupported");
    }

    mod.directive(dashToCamel(name), function() {
        return {
            restrict,
            controller: ctrl

            //TODO: invoke ctrl $onInit in link?
        };
    });
}

function setupDeclaration(mod: angular.IModule, decl): void {
    if (decl.$$component) {
        setupComponent(mod, decl, decl.$$component);
    }
    else if (decl.$$directive) {
        setupDirective(mod, decl, decl.$$directive);
    }
    else {
        throw new Error(`Unknown declaration: ${decl}`);
    }
}



/**
 * @Injectable()
 *
 * Marks a class as injectable. Required in this library, optional in Angular.
 *
 * https://angular.io/docs/ts/latest/api/core/index/Injectable-decorator.html
 */
//https://github.com/angular/angular/blob/2.4.5/modules/%40angular/core/src/di/metadata.ts#L146
export function Injectable(): ClassDecorator {
    return function<T>(constructor: Type<T>): void {
        (<any>constructor).$$injectable = true;
    };
}


/**
 * @Inject
 *
 * Manually inject by name.
 *
 * https://angular.io/docs/ts/latest/api/core/index/Inject-decorator.html
 */
//https://github.com/angular/angular/blob/2.4.5/modules/%40angular/core/src/di/metadata.ts#L53
export function Inject(thing: string): ParameterDecorator {
    return function(target: any, propertyKey: string, propertyIndex: number): void {
        getInjectArray(target)[propertyIndex] = thing;
    };
}


/**
 * Paramaters for @Pipe
 *
 * https://angular.io/docs/ts/latest/api/core/index/Pipe-interface.html
 */
//https://github.com/angular/angular/blob/2.4.5/modules/%40angular/core/src/metadata/directives.ts#L743
export interface Pipe {
    name: string;
    pure?: boolean;
}

/**
 * PipeTransform interface for @Pipe classes.
 *
 * https://angular.io/docs/ts/latest/api/core/index/PipeTransform-interface.html
 */
//https://github.com/angular/angular/blob/2.4.5/modules/%40angular/core/src/change_detection/pipe_transform.ts#L38
export interface PipeTransform {
    transform: (value: any, ...args: any[]) => any;
}

/**
 * @Pipe
 *
 * Marks a class as a Pipe.
 *
 * Works as a filter in AngularJS.
 */
export function Pipe(info: Pipe): ClassDecorator {
    return function(constructor: PipeTransform): void {
        (<any>constructor).$$pipe = info;
    };
}


interface InternalInputMetadata {
    name: string;
    publicName: string;
    type: string;
}
function createInputDecorator(type: string) {
    return function InputDecorator(publicName?: string): PropertyDecorator {
        return function(targetPrototype: Object, propertyKey: string): void {
            const constructor = <any>targetPrototype.constructor;

            (constructor.$$inputs || (constructor.$$inputs = [])).push(<InternalInputMetadata>{
                name: propertyKey,
                publicName,
                type
            });
        };
    };
}

/**
 * @Input
 *
 * Marks a field as a Component/Directive input.
 *
 * https://angular.io/docs/ts/latest/api/core/index/Input-interface.html
 */
export const Input = createInputDecorator("<");

/**
 * @InputString
 *
 * Non-standard helper for declaring input strings. Could be converted to plain @Input in Angular.
 *
 * Works as a @-binding in AngularJS.
 */
export const InputString = createInputDecorator("@");

/**
 * @InputCallback
 *
 * Non-standard helper for declaring callback style bindings.
 * **WARNING** Has no direct Angular replacement. Try to use @Output EventEmmitter instead.
 *
 * Works as a &-binding in AngularJS.
 */
export const InputCallback = createInputDecorator("&");

/**
 * @Require
 *
 * Non-standard helper for AngularJS `require`.
 */
export function Require(name?: string): PropertyDecorator {
    const needsName = !name || /^[\^\?]+$/.test(name);

    return function(targetPrototype: Object, propertyKey: string): void {
        const constructor = <any>targetPrototype.constructor;

        (constructor.$$require || (constructor.$$require = {}))[propertyKey] = (name || "") + (needsName ? propertyKey : "");
    };
}


/**
 * A subset of the @Directive interface
 */
//https://github.com/angular/angular/blob/2.4.5/modules/%40angular/core/src/metadata/directives.ts#L79
export interface Directive {
    selector: string;

    inputs?: string[];

    //NOT SUPPORTED...
    // providers: Provider[];
    // exportAs: string;
    // queries: {[key: string]: any};
    // host: {[key: string]: string};

    //MAYBE LATER:
    // outputs: string[];    requires EventEmitter?
}

/**
 * @Directive
 *
 * Marks a class as a directive. A subset of the standard Angular features.
 *
 * https://angular.io/docs/ts/latest/api/core/index/Directive-decorator.html
 */
export function Directive(info: Directive): ClassDecorator {
    return function<T>(constructor: Type<T>): void {
        (<any>constructor).$$directive = info;
    };
}


/**
 * A subset of the @Component interface
 */
//https://github.com/angular/angular/blob/2.4.5/modules/%40angular/core/src/metadata/directives.ts#L487
export interface Component extends Directive {
    template?: string | any;    //NOTE: added "| any" to support CJS `require(...)`

    //AngularJS specific
    transclude?: boolean | {[slot: string]: string};
    controllerAs?: string;


    //NOT SUPPORTED...
    // animations: AnimationEntryMetadata[];
    // encapsulation: ViewEncapsulation;
    // interpolation: [string, string];
    // changeDetection: ChangeDetectionStrategy;

    //Loading of templates + stylesheets must be done elsewhere (ex: webpack)
    // moduleId: string;
    // templateUrl: string;
    // styleUrls: string[];
    // styles: string[];

    // Dependencies on other component/directives
    // viewProviders: Provider[];

    //Component dependencies
    // entryComponents: Array<Type<any>|any[]>;
}

/**
 * @Component
 *
 * Mark a class as a component. A subset of the standard Angular features.
 *
 * Additions:
 *     transclude: for AngularJS transclusion
 *     controllerAs: for AngularJS naming of controllers
 *
 * https://angular.io/docs/ts/latest/api/core/index/Component-decorator.html
 */
export function Component(info: Component): ClassDecorator {
    return function<T>(constructor: Type<T>): void {
        (<any>constructor).$$component = info;
    };
}


/**
 * A subset of the @NgModule interface
 */
//https://github.com/angular/angular/blob/2.4.5/modules/%40angular/core/src/metadata/ng_module.ts#L70
export interface NgModule {
    id: string;

    providers?: /*Provider*/any[];
    declarations?: Array<Type<any>|any[]>;
    imports?: Array<angular.IModule|Type<any>|string>;

    //NOT SUPPORTED...
    // entryComponents: Array<Type<any>|any[]>;
    // bootstrap: Array<Type<any>|any[]>;
    // schemas: Array<SchemaMetadata|any[]>;

    //Everything is exported in AngularJS
    // exports: Array<Type<any>|any[]>;
}

/**
 * @NgModule
 *
 * Mark a class as a module. A subset of the standard Angular features.
 *
 * Additions:
 *      Allows AngularJS modules (or names) as imports
 *
 * https://angular.io/docs/ts/latest/api/core/index/NgModule-interface.html
 */
export function NgModule(info: NgModule) {
    return function<T>(constructor: Type<T>): void {
        const mod = module(info.id, (info.imports || []).map(getModuleName));

        (info.providers || []).forEach(function(provider) {
            setupProvider(mod, provider);
        });

        (info.declarations || []).forEach(function(decl) {
            setupDeclaration(mod, decl);
        });

        //Invoke the constructor when the module is setup
        //TODO: create an instance?
        mod.run(constructor);

        (<any>constructor).$$module = info.id;
    };
}


// Decorate the AngularJS injector to support Types in addition to standard strings.
// Follow the Types + arguments declared in @Types definition
module("ng").decorator("$injector", ["$delegate", function(injector/*: angular.auto.IInjectorService*/): angular.auto.IInjectorService {
    //Avoid the use of ?:Type (optional) params to allow the wrapped methods to do defaulting instead of TS
    //Otherwise signatures should be the same or extend the originals

    const {get, has, instantiate, invoke} = injector;

    // get<T>(name: string, caller?: string): T;
    injector.get = function diGetWrapper<T>(what: string | Type<any>, caller: string): T {
        return get.call(this, getTypeName(what), caller);
    };

    // has(name: string): boolean;
    // const has = injector.has;
    injector.has = function diHasWrapper(what: string | Type<any>): boolean {
        return has.call(this, getTypeName(what));
    };

    // instantiate<T>(typeConstructor: Function, locals?: any): T;
    injector.instantiate = function diInstantiateWrapper(typeConstructor: Function, locals: any) {
        return instantiate.call(this, injectMethod(typeConstructor), locals);
    };

    // invoke(inlineAnnotatedFunction: any[]): any;
    // invoke(func: Function, context?: any, locals?: any): any;
    injector.invoke = function diInvokeWrapper(method: any[] | Function, context: any, locals: any) {
        return invoke.call(this, injectMethod(method), context, locals);
    };

    return injector;
}]);