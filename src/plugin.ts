/*
 * Copyright 2024 Teppo Kurki <teppo.kurki@iki.fi>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Context, Path, Source, SourceRef, Timestamp, Value } from '@signalk/server-api'
import { Observable, filter, map, scan } from 'rxjs'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageInfo = require('../package.json')

export interface Logging {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (...args: any) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (...args: any) => void
}

interface Plugin {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  start: (c: PluginConfig) => Promise<unknown>
  stop: () => void
  // signalKApiRoutes: (r: Router) => Router
  id: string
  name: string
  description: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any
}

enum QuantityType {
  angular = 'angular',
  linear = 'linear',
}

interface PathCalc {
  path: string
  $source: string
  type: QuantityType
  numberOfUpdates?: number
}
export interface PluginConfig {
  pathCalcs: PathCalc[]
}

interface App extends Logging {
  selfId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  streambundle: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleMessage: any
}

interface FlatValue {
  path: Path
  value: Value
  context: Context
  source?: Source
  $source: SourceRef
  timestamp: Timestamp
}

interface AngularValue {
  sin: number
  cos: number
  $source: SourceRef
}

// Used to identify derived aggregate values for users
// and so that we can ignore these values in input
const SOURCE_POSTFIX = '_a'

export default function InfluxPluginFactory(app: App): Plugin {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const schema = require('../dist/PluginConfig.json')

  let onStop: (() => void)[] = []

  return {
    start: function (config: PluginConfig) {
      config.pathCalcs.forEach(({ path, numberOfUpdates, $source }) => {
        //include the necessary parameters in the derived $source so that we can have
        //multiple independent aggregates for a single path, distinguishable by $source
        const derivedSource = `${$source}_avg${numberOfUpdates}${SOURCE_POSTFIX}`

        const sourceObservable = new Observable<FlatValue>((subscriber) => {
          onStop.push(
            app.streambundle.getSelfBus(path).forEach((flatValue: FlatValue) => {
              if (flatValue.$source === $source) {
                subscriber.next(flatValue)
              }
            }),
          )
        })
        pipeToAngleAverage(sourceObservable, numberOfUpdates || 10).subscribe(({ value }) =>
          app.handleMessage('', {
            updates: [
              {
                $source: derivedSource,
                values: [
                  {
                    path: `${path}`,
                    value: value,
                  },
                ],
              },
            ],
          }),
        )
      })
      return Promise.resolve()
    },

    stop: () => {
      onStop.forEach((f) => f())
      onStop = []
    },

    id: packageInfo.name,
    name: packageInfo.description,
    description: '',
    schema,
  }
}

const pipeToAngleAverage = (o: Observable<FlatValue>, numberOfUpdates: number) =>
  o.pipe(
    filter((value: FlatValue) => !value.$source.endsWith(SOURCE_POSTFIX)),
    map<FlatValue, AngularValue>(({ value, $source }) => ({
      sin: Math.sin(value as number),
      cos: Math.cos(value as number),
      $source,
    })),
    scan((acc, value) => {
      acc.push(value)
      return acc.slice(Math.max(acc.length - (numberOfUpdates || 10), 0))
    }, [] as AngularValue[]),
    map<AngularValue[], { value: number; $source: SourceRef }>((sinCosBuffer) => {
      const [sinSum, cosSum, weightsSum] = sinCosBuffer.reduce<number[]>(
        (acc, { sin, cos }, i) => {
          acc[0] += sin * i
          acc[1] += cos * i
          acc[2] += i
          return acc
        },
        [0, 0, 0],
      )
      return {
        value: Math.atan2(sinSum / weightsSum, cosSum / weightsSum),
        $source: sinCosBuffer[sinCosBuffer.length - 1].$source,
      }
    }),
  )
