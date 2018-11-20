/********************************************************************************
 * Copyright (C) 2018 Red Hat, Inc. and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/
import { Emitter } from '@theia/core/lib/common/event';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { Disposable } from './../types-impl';
import { Breakpoint } from '../../api/model';
import { RPCProtocol } from '../../api/rpc-protocol';
import {
    PLUGIN_RPC_CONTEXT as Ext,
    DebugMain,
    DebugExt
} from '../../api/plugin-api';
import * as theia from '@theia/plugin';
import uuid = require('uuid');
import { PluginPackageDebuggersContribution } from '../../common/plugin-protocol';

export class DebugExtImpl implements DebugExt {
    readonly activeDebugConsole: theia.DebugConsole;

    private contributions = new Map<string, PluginPackageDebuggersContribution>();
    private configurationProviders = new Map<string, theia.DebugConfigurationProvider>();

    private proxy: DebugMain;
    private _breakpoints: theia.Breakpoint[] = [];
    private _activeDebugSession: theia.DebugSession | undefined;
    private readonly onDidChangeBreakpointsEmitter = new Emitter<theia.BreakpointsChangeEvent>();
    private readonly onDidChangeActiveDebugSessionEmitter = new Emitter<theia.DebugSession | undefined>();
    private readonly onDidTerminateDebugSessionEmitter = new Emitter<theia.DebugSession>();
    private readonly onDidStartDebugSessionEmitter = new Emitter<theia.DebugSession>();
    private readonly onDidReceiveDebugSessionCustomEmitter = new Emitter<theia.DebugSessionCustomEvent>();

    constructor(rpc: RPCProtocol) {
        this.proxy = rpc.getProxy(Ext.DEBUG_MAIN);
        this.activeDebugConsole = {
            append: (value: string) => this.proxy.$appendToDebugConsole(value),
            appendLine: (value: string) => this.proxy.$appendLineToDebugConsole(value)
        };
    }

    get onDidReceiveDebugSessionCustomEvent(): theia.Event<theia.DebugSessionCustomEvent> {
        return this.onDidReceiveDebugSessionCustomEmitter.event;
    }

    get onDidChangeActiveDebugSession(): theia.Event<theia.DebugSession | undefined> {
        return this.onDidChangeActiveDebugSessionEmitter.event;
    }

    get onDidTerminateDebugSession(): theia.Event<theia.DebugSession> {
        return this.onDidTerminateDebugSessionEmitter.event;
    }

    get onDidStartDebugSession(): theia.Event<theia.DebugSession> {
        return this.onDidStartDebugSessionEmitter.event;
    }

    get onDidChangeBreakpoints(): theia.Event<theia.BreakpointsChangeEvent> {
        return this.onDidChangeBreakpointsEmitter.event;
    }

    get breakpoints(): theia.Breakpoint[] {
        return this._breakpoints;
    }

    get activeDebugSession(): theia.DebugSession | undefined {
        return this._activeDebugSession;
    }

    addBreakpoints(breakpoints: theia.Breakpoint[]): void {
        this.proxy.$addBreakpoints(breakpoints);
    }

    removeBreakpoints(breakpoints: theia.Breakpoint[]): void {
        this.proxy.$removeBreakpoints(breakpoints);
    }

    startDebugging(folder: theia.WorkspaceFolder | undefined, nameOrConfiguration: string | theia.DebugConfiguration): Thenable<boolean> {
        return Promise.resolve(true);
    }

    registerDebugConfigurationProvider(provider: theia.DebugConfigurationProvider, contribution: PluginPackageDebuggersContribution): Disposable {
        const contributionId = uuid.v4();
        this.contributions.set(contributionId, contribution);
        this.configurationProviders.set(contributionId, provider);

        this.proxy.$registerDebugConfigurationProvider(contributionId, contribution);

        return Disposable.create(() => {
            this.configurationProviders.delete(contributionId);
            this.contributions.delete(contributionId);
            this.proxy.$unregisterDebugConfigurationProvider(contributionId);
        });
    }

    $onSessionCustomEvent(sessionId: string, debugConfiguration: theia.DebugConfiguration, event: string, body?: any): void {
        this.onDidReceiveDebugSessionCustomEmitter.fire({
            event, body,
            session: this.makeProxySession(sessionId, debugConfiguration)
        });
    }

    $sessionDidCreate(sessionId: string, debugConfiguration: theia.DebugConfiguration): void {
        this.onDidStartDebugSessionEmitter.fire(this.makeProxySession(sessionId, debugConfiguration));
    }

    $sessionDidDestroy(sessionId: string, debugConfiguration: theia.DebugConfiguration): void {
        this.onDidTerminateDebugSessionEmitter.fire(this.makeProxySession(sessionId, debugConfiguration));
    }

    $sessionDidChange(sessionId: string | undefined, debugConfiguration?: theia.DebugConfiguration): void {
        this._activeDebugSession = sessionId ? this.makeProxySession(sessionId, debugConfiguration!) : undefined;
        this.onDidChangeActiveDebugSessionEmitter.fire(this._activeDebugSession);
    }

    $breakpointsDidChange(all: Breakpoint[], added: Breakpoint[], removed: Breakpoint[], changed: Breakpoint[]): void {
        this._breakpoints = all;
        this.onDidChangeBreakpointsEmitter.fire({ added, removed, changed });
    }

    $provideDebugConfigurations(contributionId: string, folder: string | undefined): Promise<theia.DebugConfiguration[]> {
        const configurations = new Deferred<theia.DebugConfiguration[]>();

        const configurationProvider = this.configurationProviders.get(contributionId);
        if (configurationProvider && configurationProvider.provideDebugConfigurations) {
            const result = configurationProvider.provideDebugConfigurations(undefined);

            if (result === undefined) {
                configurations.resolve([]);
            } else if (Array.isArray(result)) {
                configurations.resolve(result);
            } else {
                result.then(value => configurations.resolve(value || []));
            }
        } else {
            configurations.resolve([]);
        }

        return configurations.promise;
    }

    $resolveDebugConfigurations(contributionId: string, debugConfiguration: theia.DebugConfiguration, folder: string | undefined): Promise<theia.DebugConfiguration | undefined> {
        const resolvedConfiguration = new Deferred<theia.DebugConfiguration | undefined>();

        const configurationProvider = this.configurationProviders.get(contributionId);
        if (configurationProvider && configurationProvider.resolveDebugConfiguration) {
            const result = configurationProvider.resolveDebugConfiguration(undefined, debugConfiguration);

            if (result === undefined) {
                resolvedConfiguration.resolve(undefined);
            } else if (typeof result.then === 'function') {
                result.then((value: theia.DebugConfiguration | undefined) => resolvedConfiguration.resolve(value));
            } else {
                resolvedConfiguration.resolve(result as theia.DebugConfiguration);
            }
        } else {
            resolvedConfiguration.resolve(undefined);
        }

        return resolvedConfiguration.promise;
    }

    private makeProxySession(sessionId: string, configuration: theia.DebugConfiguration): theia.DebugSession {
        return {
            id: sessionId,
            type: configuration.type,
            name: configuration.name,
            customRequest: (command: string, args?: any): Thenable<any> => Promise.resolve()
        };
    }
}