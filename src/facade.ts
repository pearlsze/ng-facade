/**
 * @license ng-facade
 * (c) 2017 Jason Bedard
 * License: MIT
 */

import {extend, identity, module, noop} from "angular";

/* TODO...
    - component lifecycle interfaces: https://angular.io/docs/ts/latest/guide/lifecycle-hooks.html ?
    - @Optional, @Self, @SkipSelf, @Host
    - @ViewChild ?
    - ElementRef ? (https://github.com/angular/angular/blob/2.4.5/modules/%40angular/core/src/linker/element_ref.ts#L24)
*/


function valueFn<T>(v: T): () => T { return () => v; };

//https://github.com/angular/angular/blob/2.4.8/modules/%40angular/core/src/type.ts
const Type = Function;
export interface Type<T> extends Function { new (...args: any[]): T; }


export type Injectable<T extends Function> = T | Array<string | Type<any> | any | T>;

//Create alternate name for augmenting into "angular" namespace
export type FacadeInjectable<T extends Function> = Injectable<T>;


//Augment some AngularJS interfaces to allow passing types.
//Basically copy and pasted, but use the local `Injectable` which allows injecting by type.
//https://www.typescriptlang.org/docs/handbook/declaration-merging.html#module-augmentation
declare module "angular" {
    interface IModule {
        controller(name: string | Type<any>, controllerConstructor: FacadeInjectable<angular.IControllerConstructor>): angular.IModule;
        controller(object: {[name: string]: FacadeInjectable<angular.IControllerConstructor>}): angular.IModule;

        directive(name: string | Type<any>, directiveFactory: FacadeInjectable<angular.IDirectiveFactory>): angular.IModule;
        directive(object: {[directiveName: string]: FacadeInjectable<angular.IDirectiveFactory>}): angular.IModule;

        factory(name: string | Type<any>, $getFn: FacadeInjectable<Function>): angular.IModule;
        factory(object: {[name: string]: FacadeInjectable<Function>}): angular.IModule;

        filter(name: string, filterFactoryFunction: FacadeInjectable<Function>): angular.IModule;
        filter(object: {[name: string]: FacadeInjectable<Function>}): angular.IModule;

        run(initializationFunction: FacadeInjectable<Function>): angular.IModule;

        service(name: string | Type<any>, serviceConstructor: FacadeInjectable<Function>): angular.IModule;
        service(object: {[name: string]: FacadeInjectable<Function>}): angular.IModule;

        decorator(name: string | Type<any>, decorator: FacadeInjectable<Function>): angular.IModule;
    }

    namespace auto {
        interface IInjectorService {
            get<T>(type: Type<T>, caller?: string): T;
            get(type: any, caller?: string): any;
            has(type: any): boolean;
        }

        interface IProvideService {
            constant(type: Type<any>, value: any): void;
            decorator(type: Type<any>, decorator: Function | any[]): void;
            factory(type: Type<any>, serviceFactoryFunction: Function | any[]): angular.IServiceProvider;
            provider(type: Type<any>, provider: Function | angular.IServiceProvider): angular.IServiceProvider;
            service(type: Type<any>, constructor: Function | any[]): angular.IServiceProvider;
            value(type: Type<any>, value: any): angular.IServiceProvider;
        }
    }
}


//For internal data, could be swapped for map-like structures
function hasMeta(k: string, o: any): boolean {
    return Reflect.hasOwnMetadata(k, o);
}
function setMeta(k: string, v: any, o: any): void {
    Reflect.defineMetadata(k, v, o);
}
function getMeta(k: string, o: any): any {
    return Reflect.getOwnMetadata(k, o);
}

function getOrSetMeta<T>(metadataKey: string, metadataValue: T, target: Object): T {
    let v: T = getMeta(metadataKey, target);
    if (undefined === v) {
        setMeta(metadataKey, v = metadataValue, target);
    }
    return v;
}

//Internal data keys
const META_COMPONENT  = "@Component";
const META_DIRECTIVE  = "@Directive";
const META_INJECTABLE = "@Injectable";
const META_INPUTS     = "@Input";
const META_MODULE     = "@NgModule";
const META_PIPE       = "@Pipe";
const META_PRE_LINK   = "preLink";
const META_REQUIRE    = "@Require";

function getTypeName(type: string | Type<any>): string {
    if (typeof type === "string") {
        return type;
    }
    return <string>getMeta(META_INJECTABLE, type);
}

//A counter/uid for Object => string identifiers
let tid = 0;

function toTypeName(type: string | Type<any>): string {
    let typeName = getTypeName(type);
    if (!typeName) {
        typeName = (<any>type).name + (window["angular"].mock ? "" : `_${tid++}`);
        setMeta(META_INJECTABLE, typeName, type);
    }
    return typeName;
}

function getModuleName(mod: string | angular.IModule | Type<any>): string {
    if (typeof mod !== "string") {
        if (hasMeta(META_MODULE, mod)) {
            mod = (<NgModule>getMeta(META_MODULE, mod)).id;
        }
        else {
            mod = (<angular.IModule>mod).name;
        }
    }
    return mod;
}

function getInjectArray(target: Injectable<any>): Array<Injectable<any>> {
    return target.$inject || (target.$inject = <string[]>(target.$inject || []));
}

function dashToCamel(s: string): string {
    return s.replace(/-([a-z])/g, (a, letter) => letter.toUpperCase());
}


const COMPONENT_SELF_BINDING = "$$self";


/**
 * Build the AngularJS style `$inject` array for the passed object, converting Angular style to AngularJS.
 *
 * Supports:
 *    - AngularJS style `['InjectedName', InjectedClass, methodFoo]` or `methodFoo.$inject = ['InjectedName', InjectedClass]`
 *    - Angular style `@Injectable() class Foo { constructor(@Inject("InjectedName") localName){} }`
 *    - Angular style `@Injectable() class Foo { constructor(private localName: InjectedClass){} }`
 *    - any mix of the above
 */
function injectMethod(method: Injectable<any>) {
    //Array<string | Type> => Array<string>
    if (Array.isArray(method)) {
        for (let i = 0; i < method.length - 1; i++) {
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

        for (let i = 0; i < paramTypes.length; i++) {
            //Try to extract types via TypeScript if currently unknown
            if (undefined === $inject[i]) {
                $inject[i] = paramTypes[i];
            }
        }
    }

    //Types extracted from TypeScript or specificed manually in $inject
    const $inject = method.$inject;
    if ($inject) {
        for (let i = 0; i < $inject.length; i++) {
            //Convert type => string for injection via types
            if (typeof $inject[i] !== "string") {
                $inject[i] = getTypeName($inject[i]);
            }
        }
    }

    return method;
}


function isPipeTransform(o: Provider): o is PipeTransform & TypeProvider {
    return hasMeta(META_PIPE, o);
}
function isExistingProvider(o: Provider): o is ExistingProvider {
    return "useExisting" in o;
}
function isFactoryProvider(o: Provider): o is FactoryProvider  {
    return "useFactory" in o;
}
function isClassProvider(o: Provider): o is ClassProvider {
    return "useClass" in o;
}
function isValueProvider(o: Provider): o is ValueProvider {
    return "useValue" in o;
}

function setupProvider(mod: angular.IModule, provider: Provider): void {
    //Provider type detection similar to:
    // https://github.com/angular/angular/blob/2.4.4/modules/%40angular/core/src/di/reflective_provider.ts#L103
    // +
    // https://github.com/angular/angular/blob/2.4.4/modules/%40angular/core/src/di/reflective_provider.ts#L181

    //PipeTransform
    if (isPipeTransform(provider)) {
        const pipeInfo: Pipe = getMeta(META_PIPE, provider);
        mod.service(provider, provider);
        mod.filter(pipeInfo.name, [provider, function(pipe: PipeTransform) {
            const transform = pipe.transform.bind(pipe);
            transform.$stateful = (false === pipeInfo.pure);
            return transform;
        }]);
    }
    //ExistingProvider
    else if (isExistingProvider(provider)) {
        mod.factory(provider.provide, [provider.useExisting, identity]);
    }
    //FactoryProvider
    else if (isFactoryProvider(provider)) {
        mod.factory(provider.provide, extend(provider.useFactory, {$inject: provider.deps || []}));
    }
    //ClassProvider
    else if (isClassProvider(provider)) {
        mod.service(provider.provide, provider.useClass);
    }
    //ValueProvider
    else if (isValueProvider(provider)) {
        mod.factory(provider.provide, valueFn(provider.useValue));
    }
    //TypeProvider
    else /*if (provider instanceof Type)*/ {
        mod.service(getTypeName(<Type<any>>provider), <TypeProvider>provider);
    }
}

function createCompileFunction(ctrl: Type<any>, $injector: angular.auto.IInjectorService): angular.IDirectiveCompileFn | undefined {
    const pre: Array<Injectable<any>> = getMeta(META_PRE_LINK, ctrl.prototype);

    if (pre) {
        return valueFn({
            pre($scope: angular.IScope, $element: JQuery, $attrs: angular.IAttributes, ctrls: {[key: string]: angular.IController}) {
                const locals = {$scope, $element, $attrs};
                for (const f of pre) {
                    $injector.invoke(f, ctrls[COMPONENT_SELF_BINDING], locals);
                }
            }
        });
    }
    return undefined;
}

function addPreLink(targetPrototype: Object, fn: Injectable<any>): void {
    getOrSetMeta(META_PRE_LINK, <Array<Injectable<any>>>[], targetPrototype).push(fn);
}

function setupComponent(mod: angular.IModule, ctrl: Type<any>, decl: Component): void {
    const bindings: {[name: string]: string} = {};

    //@Input(Type)s
    (getMeta(META_INPUTS, ctrl) || []).forEach(function(input: InternalBindingMetadata) {
        bindings[input.name] = input.type + "?" + (input.publicName || "");
    });

    //Reference to self
    const require = {[COMPONENT_SELF_BINDING]: dashToCamel(decl.selector)};

    //@Require()s
    const required = getMeta(META_REQUIRE, ctrl);
    for (const key in required) {
        require[key] = dashToCamel(required[key]);
    }

    //Simplified component -> directive mapping similar to
    // https://github.com/angular/angular.js/blob/v1.6.2/src/ng/compile.js#L1227

    mod.directive(dashToCamel(decl.selector), ["$injector", function($injector: angular.auto.IInjectorService): angular.IDirective {
        return {
            //https://github.com/angular/angular.js/blob/v1.6.2/src/ng/compile.js#L1242-L1252
            controller: ctrl,
            controllerAs: decl.controllerAs || "$ctrl",
            template: decl.template,
            transclude: decl.transclude,
            scope: {},
            bindToController: bindings,
            restrict: "E",
            require,

            //Create a compile function to do setup
            compile: createCompileFunction(ctrl, $injector)
        };
    }]);
}

function setupDirective(mod: angular.IModule, ctrl: Type<any>, decl: Directive): void {
    //Element vs attribute
    //AngularJS does not support complex selectors
    //Angular does not support comments
    let name = decl.selector;
    let restrict = "E";
    if (name[0] === "[" && name[name.length - 1] === "]") {
        name = name.slice(1, name.length - 1);
        restrict = "A";
    }
    else if (name[0] === ".") {
        name = name.slice(1);
        restrict = "C";
    }

    //TODO: inputs on Directive which has no isolated scope?
    if (hasMeta(META_INPUTS, ctrl)) {
        throw new Error("Directive input unsupported");
    }

    //TODO: require on Directive which has no isolated scope?
    if (hasMeta(META_REQUIRE, ctrl)) {
        throw new Error("Directive require unsupported");
    }

    //reference to self
    const require = {[COMPONENT_SELF_BINDING]: dashToCamel(name)};

    mod.directive(dashToCamel(name), ["$injector", function($injector: angular.auto.IInjectorService): angular.IDirective {
        return {
            restrict,
            controller: ctrl,
            require,

            //Create a compile function to do setup
            compile: createCompileFunction(ctrl, $injector)
        };
    }]);
}

function setupDeclaration(mod: angular.IModule, decl: Type<any>): void {
    if (hasMeta(META_COMPONENT, decl)) {
        setupComponent(mod, decl, getMeta(META_COMPONENT, decl));
    }
    else if (hasMeta(META_DIRECTIVE, decl)) {
        setupDirective(mod, decl, getMeta(META_DIRECTIVE, decl));
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
        toTypeName(constructor);
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
    return function(target: Object, propertyKey: string, propertyIndex: number): void {
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
    return function(constructor: Type<PipeTransform>): void {
        toTypeName(constructor);
        setMeta(META_PIPE, info, constructor);
    };
}


interface InternalBindingMetadata {
    name: string;
    publicName: string | undefined;
    type: string;
}

function addBinding(targetPrototype: Object, data: InternalBindingMetadata): void {
    getOrSetMeta(META_INPUTS, <InternalBindingMetadata[]>[], targetPrototype.constructor).push(data);
}

function createInputDecorator(type: string) {
    return function InputDecorator(publicName?: string): PropertyDecorator {
        return function(targetPrototype: Object, propertyKey: string): void {
            addBinding(targetPrototype, {
                name: propertyKey,
                publicName: publicName && dashToCamel(publicName),
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


const OUTPUT_BOUND_CALLBACK_PREFIX = "__event_";

/**
 * @Output
 *
 * https://angular.io/docs/ts/latest/api/core/index/Output-interface.html
 */
export function Output(publicName?: string): PropertyDecorator {
    return function(targetPrototype: Object, propertyKey: string): void {
        const propertyType: Type<any> = Reflect.getMetadata("design:type", targetPrototype, propertyKey);
        if (!(propertyType === EventEmitter || propertyType.prototype instanceof EventEmitter)) {
            throw new Error(`${(<any>targetPrototype.constructor).name}.${propertyKey} type must be EventEmitter`);
        }

        const internalCallback = OUTPUT_BOUND_CALLBACK_PREFIX + propertyKey;

        addBinding(targetPrototype, {
            name: internalCallback,
            publicName: publicName && dashToCamel(publicName) || propertyKey,
            type: "&"
        });

        addPreLink(targetPrototype, function(this: Type<any>) {
            (<EventEmitter<any>>this[propertyKey]).emit = (value) => {
                (this[internalCallback] || noop)({$event: value});
            };
        });
    };
};

/**
 * EventEmitter
 *
 * A subset of the Angular interface.
 *
 * https://angular.io/docs/ts/latest/api/core/index/EventEmitter-class.html
 */
//https://github.com/angular/angular/blob/2.4.7/modules/%40angular/facade/src/async.ts
export class EventEmitter<T> {
    public emit(value?: T): void {
        throw new Error("Uninitialized EventEmitter");
    }
}


/**
 * @HostListener
 *
 * Bind a DOM event to the host element.
 *
 * https://angular.io/docs/ts/latest/api/core/index/HostListener-interface.html
 */
//https://github.com/angular/angular/blob/2.4.5/modules/%40angular/core/src/metadata/directives.ts#L1005-L1017
export function HostListener(eventType: string, args: string[] = []): MethodDecorator {
    return function(targetPrototype: Object, propertyKey: string): void {
        function HostListenerSetup(this: Type<any>, $element: JQuery, $parse: angular.IParseService, $rootScope: angular.IScope): void {
            //Parse the listener arguments on component initialization
            const argExps = args.map((s) => $parse(s));

            $element.on(eventType, ($event: BaseJQueryEventObject) => {
                //Invoke each argument expression specifying the $event local
                const argValues = argExps.map((argExp) => argExp({$event}));
                const invokeListener = () => this[propertyKey](...argValues);

                if (!$rootScope.$$phase) {
                    $rootScope.$apply(invokeListener);
                }
                else {
                    invokeListener();
                }
            });
        }
        HostListenerSetup.$inject = ["$element", "$parse", "$rootScope"];

        addPreLink(targetPrototype, HostListenerSetup);
    };
}


/**
 * @Require
 *
 * Non-standard helper for AngularJS `require`.
 */
export function Require(name?: string): PropertyDecorator {
    const needsName = !name || /^[\^\?]+$/.test(name);

    return function(targetPrototype: Object, propertyKey: string): void {
        getOrSetMeta(META_REQUIRE, {}, targetPrototype.constructor)[propertyKey] = (name || "") + (needsName ? propertyKey : "");
    };
}


/**
 * A subset of the @Directive interface
 */
//https://github.com/angular/angular/blob/2.4.5/modules/%40angular/core/src/metadata/directives.ts#L79
export interface Directive {
    selector: string;

    //NOT SUPPORTED...
    // providers: Provider[];
    // exportAs: string;
    // queries: {[key: string]: any};
    // host: {[key: string]: string};

    //MAYBE LATER:
    // inputs?: string[];
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
    return function(constructor: Type<any>): void {
        setMeta(META_DIRECTIVE, info, constructor);
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
    return function(constructor: Type<any>): void {
        setMeta(META_COMPONENT, info, constructor);
    };
}


//https://github.com/angular/angular/blob/2.4.8/modules/%40angular/core/src/di/provider.ts
export interface TypeProvider extends Type<any> {}
export interface ValueProvider {
  provide: any;
  useValue: any;
  // multi?: boolean;
}
export interface ClassProvider {
  provide: any;
  useClass: Type<any>;
  // multi?: boolean;
}
export interface ExistingProvider {
  provide: any;
  useExisting: any;
  // multi?: boolean;
}
export interface FactoryProvider {
  provide: any;
  useFactory: Function;
  deps?: any[];
  // multi?: boolean;
}
export type Provider = TypeProvider | ValueProvider | ClassProvider | ExistingProvider | FactoryProvider/* | any[]*/;


/**
 * A subset of the @NgModule interface
 */
//https://github.com/angular/angular/blob/2.4.5/modules/%40angular/core/src/metadata/ng_module.ts#L70
export interface NgModule {
    id: string;

    providers?: Provider[];
    declarations?: Array<Type<any>/*|any[]*/>;
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
export function NgModule(info: NgModule): ClassDecorator {
    return function(constructor: Type<any>): void {
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

        setMeta(META_MODULE, info, constructor);
    };
}

/**
 * The `OnInit` interface, with the AngularJS method $onInit() method.
 *
 * https://angular.io/docs/ts/latest/api/core/index/OnInit-class.html
 */
export interface OnInit {
    $onInit(): void;
}

/**
 * The `DoCheck` interface, with the AngularJS method $doCheck() method.
 *
 * https://angular.io/docs/ts/latest/api/core/index/DoCheck-class.html
 */
export interface DoCheck {
    $doCheck(): void;
}

/**
 * The `OnChanges` interface, with the AngularJS method $onChanges(IOnChangesObject) method.
 *
 * https://angular.io/docs/ts/latest/api/core/index/OnChanges-class.html
 */
export interface OnChanges {
    $onChanges(onChangesObj: angular.IOnChangesObject): void;
}

/**
 * The `OnDestroy` interface, with the AngularJS method $onDestroy() method.
 *
 * https://angular.io/docs/ts/latest/api/core/index/OnDestroy-class.html
 */
export interface OnDestroy {
    $onDestroy(): void;
}

//TODO?: $postLink(): void


// Decorate the AngularJS injector to support Types in addition to standard strings.
// Follow the Types + arguments declared in @types definition + the ng-facade overrides
module("ng").decorator("$injector", ["$delegate", function(injector: angular.auto.IInjectorService): angular.auto.IInjectorService {
    const {get, has, instantiate, invoke} = injector;

    // get<T>(name: string, caller?: string): T;
    // get<T>(type: Type<T>, caller?: string): T;
    // get(type: any, caller?: string): any;
    injector.get = function diGetWrapper(this: angular.auto.IInjectorService, what: any, caller?: string): any {
        return get.call(this, getTypeName(what), caller);
    };

    // has(name: string): boolean;
    // has(type: any): boolean;
    injector.has = function diHasWrapper(this: angular.auto.IInjectorService, what: string | Type<any>): boolean {
        return has.call(this, getTypeName(what));
    };

    // instantiate<T>(typeConstructor: Function, locals?: any): T;
    injector.instantiate = function diInstantiateWrapper<T>(this: angular.auto.IInjectorService, typeConstructor: Type<T>, locals: any): T {
        return instantiate.call(this, injectMethod(typeConstructor), locals);
    };

    // invoke(inlineAnnotatedFunction: any[]): any;
    // invoke(func: Function, context?: any, locals?: any): any;
    injector.invoke = function diInvokeWrapper(this: angular.auto.IInjectorService, thing, ...args) {
        return invoke.call(this, injectMethod(thing), ...args);
    };

    return injector;
}]);

// Decorate (at config) the AngularJS $provide to allow non-string IDs.
// Follow the Types + arguments declared in @types definition + the ng-facade overrides
module("ng").config(["$provide", function(provide: angular.auto.IProvideService): void {
    ["constant", "value", "factory", "provider", "service"].forEach(function(method) {
        const delegate = provide[method];

        function diProvideWrapper(this: angular.auto.IProvideService, key: string | Type<any>, value: Function | any | any[]): angular.IServiceProvider;
        function diProvideWrapper(this: angular.auto.IProvideService, key: string | Type<any>, value: angular.IServiceProvider): angular.IServiceProvider;
        function diProvideWrapper(this: angular.auto.IProvideService, multi: {key: string, value: any}): void;

        function diProvideWrapper(this: angular.auto.IProvideService, key: string | Type<any> | {key: string, value: any}, value?: Function | angular.IServiceProvider | any[]): angular.IServiceProvider | void {
            if (arguments.length === 1) {
                for (const objKey in <Object>key) {
                    delegate(objKey, key[objKey]);
                }
            }
            else {
                return delegate(toTypeName(<string | Type<any>>key), <Function | any | any[]>value);
            }
        }

        provide[method] = diProvideWrapper;
    });

    const decorator = provide.decorator;

    // decorator(type: Type<any>, decorator: Function): void;
    // decorator(type: Type<any>, inlineAnnotatedFunction: any[]): void;
    provide.decorator = function diDecorator(this: angular.auto.IProvideService, type: Type<any> | string, dec: Function | any[]): void {
        decorator.call(this, toTypeName(type), dec);
    };
}]);