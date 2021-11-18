import {
  Action,
  AsyncThunk,
  AsyncThunkAction,
  AsyncThunkOptions,
  AsyncThunkPayloadCreator,
  createAsyncThunk,
} from "@reduxjs/toolkit"
import dayjs from "dayjs"
import { convertToEth } from "../lib/utils"
import { AnyEVMTransaction } from "../networks"

// Below, we use `any` to deal with the fact that allAliases is a heterogeneous
// collection of async thunk actions whose payload types have little in common
// with each other.
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A list of all webext-redux aliases that have been registered globally. These
 * are generally updated automatically by helpers like
 * `createBackgroundAsyncThunk` and should rarely need to be touched directly.
 *
 * webext-redux aliases are actions that are only run in the background script,
 * but can be invoked with a payload in UI and other scripts. Their type and
 * payload is relayed to the background, and the background uses an enriched
 * action creator to turn them into the final intent. They are primarily used
 * for more complex actions that require middleware to process, such as thunks.
 *
 * @see {@link createBackgroundAsyncThunk} for an example use.
 */
export const allAliases: Record<
  string,
  (action: {
    type: string
    payload: any
  }) => AsyncThunkAction<unknown, unknown, any>
> = {}
/* eslint-enable @typescript-eslint/no-explicit-any */

// All props of an AsyncThunk.
type AsyncThunkProps = keyof AsyncThunk<
  unknown,
  unknown,
  Record<string, unknown>
>

// The type system will make sure we've listed all additional props that redux
// toolkit adds to the AsyncThunk action creator below.
//
// The approach is a bit ugly, but the goal here is transparent usage wrt
// createAsyncThunk, and this allows ensuring that any future upgrades don't
// break expectations without breaking the compile.
type ExhaustivePropList<PropListType, TargetType> =
  PropListType extends readonly (infer T)[]
    ? keyof TargetType extends T
      ? readonly T[]
      : never
    : never
const asyncThunkProperties = (() => {
  const temp = ["typePrefix", "pending", "rejected", "fulfilled"] as const

  const exhaustiveList: ExhaustivePropList<
    typeof temp,
    AsyncThunk<unknown, unknown, Record<string, unknown>>
  > = temp

  return exhaustiveList
})()

/**
 * Create an async thunk action that will always run in the background script,
 * and dispatches lifecycle actions (pending, fulfilled, rejected) on the
 * shared store. The lifecycle actions are observable on synced non-background
 * stores.
 *
 * NOTE: To ensure the action is handled correctly, a central location should
 * add the webext-redux `alias` middleware to the background store, referencing
 * the `allAliases` variable in this module. This variable exposes all async
 * thunks for use with the `alias` middleware.
 *
 * @see {@link createAsyncThunk} for more information on the `options` parameter
 *      and the `pending`, `rejected`, and `fulfilled` properties on the
 *      returned action creator. Also note that the async thunk action creator
 *      returned directly by `createAsyncThunk` is not directly exposed.
 *
 * @param typePrefix This is both the name of the action that starts the thunk
 *        process, and the prefix for the three generated actions that update the
 *        thunk status---`pending`, `rejected`, and `fulfilled`---based on the
 *        payload creator's promise status.
 * @param payloadCreator A function that will always run in the background
 *        script; this takes the action payload and runs an async action whose
 *        result is eventually dispatched normally into the redux store. When
 *        the function is initially invoked, the `typePrefix`-pending action is
 *        dispatched; if the function's returned promise resolves,
 *        `typePrefix`-fulfilled or `typePrefix`-rejected is dispatched on the
 *        store depending on the promise's settled status. When -fulfilled is
 *        dispatched, the payload is the fulfilled value of the promise.
 * @param options Additional options specified by `createAsyncThunk`, including
 *        conditions for executing the thunk vs not.
 *
 * @return A function that takes the payload and returns a plain action for
 *         dispatching on the background store. This function has four
 *         additional properties, which are the same as those returned by
 *         `createAsyncThunk`.
 */
export function createBackgroundAsyncThunk<
  TypePrefix extends string,
  Returned,
  ThunkArg = void,
  ThunkApiConfig = Record<string, unknown>
>(
  typePrefix: TypePrefix,
  payloadCreator: AsyncThunkPayloadCreator<Returned, ThunkArg, ThunkApiConfig>,
  options?: AsyncThunkOptions<ThunkArg, ThunkApiConfig>
): ((payload: ThunkArg) => Action<TypePrefix> & { payload: ThunkArg }) &
  Pick<AsyncThunk<Returned, ThunkArg, ThunkApiConfig>, AsyncThunkProps> {
  // Exit early if this type prefix is already aliased for handling in the
  // background script.
  if (allAliases[typePrefix]) {
    throw new Error("Attempted to register an alias twice.")
  }

  // Use reduxtools' createAsyncThunk to build the infrastructure.
  const baseThunkActionCreator = createAsyncThunk(
    typePrefix,
    payloadCreator,
    options
  )

  // Wrap the top-level action creator to make it compatible with webext-redux.
  const webextActionCreator = Object.assign(
    (payload: ThunkArg) => ({
      type: typePrefix,
      payload,
    }),
    // Copy the utility props on the redux-tools version to our version.
    Object.fromEntries(
      asyncThunkProperties.map((prop) => [prop, baseThunkActionCreator[prop]])
    ) as Pick<AsyncThunk<Returned, ThunkArg, ThunkApiConfig>, AsyncThunkProps>
  )

  // Register the alias to ensure it will always get proxied back to the
  // background script, where we will run our proxy action creator to fire off
  // the thunk correctly.
  allAliases[typePrefix] = (action: { type: string; payload: ThunkArg }) =>
    baseThunkActionCreator(action.payload)

  return webextActionCreator
}

function ethTransformer(value: string | number | bigint | null) {
  if (value === null) {
    return "(Unknown)"
  }
  return `${convertToEth(value)} ETH`
}

export type UIAdaptationMap<T> = {
  [P in keyof T]?: {
    readableName: string
    transformer: (value: T[P]) => string
    detailTransformer: (value: T[P]) => string
  }
}

export type ActivityItem = AnyEVMTransaction & {
  timestamp?: number
  isSent?: boolean
  blockHeight: number
  infoRows: {
    [name: string]: {
      label: string
      value: unknown
      valueDetail: string
    }
  }
}

export function adaptForUI<T>(keysMap: UIAdaptationMap<T>, item: T) {
  // The as below is dicey but reasonable in our usage.
  return Object.keys(item).reduce((previousValue, key) => {
    if (key in keysMap) {
      const knownKey = key as keyof UIAdaptationMap<T> // guaranteed to be true by the `in` test
      const keyAdjustment = keysMap[knownKey]

      return keyAdjustment === undefined
        ? previousValue
        : {
            ...previousValue,
            [keyAdjustment.readableName]: keyAdjustment.transformer(
              item[knownKey]
            ),
          }
    }
    return previousValue
  }, {})
}

export const keysMap: UIAdaptationMap<ActivityItem> = {
  blockHeight: {
    readableName: "Block Height",
    transformer: (item: number) => item.toString(),
    detailTransformer: () => {
      return ""
    },
  },
  value: {
    readableName: "Amount",
    transformer: ethTransformer,
    detailTransformer: ethTransformer,
  },
  gasUsed: {
    readableName: "Gas",
    transformer: ethTransformer,
    detailTransformer: ethTransformer,
  },
  maxFeePerGas: {
    readableName: "Max Fee/Gas",
    transformer: ethTransformer,
    detailTransformer: ethTransformer,
  },
  gasPrice: {
    readableName: "Gas Price",
    transformer: ethTransformer,
    detailTransformer: ethTransformer,
  },
  timestamp: {
    readableName: "Timestamp",
    transformer: (item) => {
      if (typeof item !== "undefined") {
        return dayjs.unix(item).format("MM/DD/YYYY hh:mm a")
      }
      return "(Unknown)"
    },
    detailTransformer: () => {
      return ""
    },
  },
}
