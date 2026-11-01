import { cn, host, useQuery, useMutation, useQueryClient } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'

const ID = 'model-cache'

function ModelGroup({ model, action, onActionQuant, onActionAll, promoting }) {
  const isPromote = action === 'promote' 
  const [expanded, setExpanded] = useState(false)
  const quants = model.quants || []
  const quantSizes = model.quant_sizes || {}

  return jsxs('div', {
    className: 'border-b border-(--ui-border-subtle)',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2 px-2 py-1.5 text-xs hover:bg-(--chrome-action-hover)',
        children: [
          jsxs('div', {
            className: 'flex-1 truncate flex items-center gap-1 cursor-pointer',
            onClick: () => setExpanded(!expanded),
            children: [
              jsx('span', { className: 'text-(--ui-text-quaternary) text-[10px]', children: expanded ? '▼' : '▶' }),
              jsx('span', { className: 'font-medium', children: model.name }),
              jsx('span', { className: 'ml-2 text-(--ui-text-quaternary)', children: model.size }),
              jsx('span', { className: 'ml-2 text-(--ui-text-quaternary) text-[10px]', children: `(${quants.length} quant${quants.length !== 1 ? 's' : ''})` }),
            ]
          }),
          jsx('button', {
            className: `px-2 py-0.5 rounded text-(--ui-text-tertiary) ${isPromote ? 'hover:text-green-400' : 'hover:text-red-400'}`,
            onClick: () => onActionAll(model.dir),
            disabled: promoting,
            children: promoting ? '...' : (isPromote ? 'promote all' : 'evict all')
          })
        ]
      }),
      expanded ? jsxs('div', {
        className: 'pl-6 pb-1',
        children: quants.length > 0
          ? quants.map(q => jsxs('div', {
              key: q,
              className: 'flex items-center justify-between gap-2 px-2 py-0.5 text-[11px] hover:bg-(--chrome-action-hover)',
              children: [
                jsxs('div', {
                  className: 'flex-1 truncate',
                  children: [
                    jsx('span', { children: q }),
                    jsx('span', { className: 'ml-2 text-(--ui-text-quaternary)', children: quantSizes[q] || '' }),
                  ]
                }),
                jsx('button', {
                  className: `px-1.5 py-0.5 rounded text-(--ui-text-quaternary) ${isPromote ? 'hover:text-green-400' : 'hover:text-red-400'} text-[10px]`,
                  onClick: () => onActionQuant(model.dir, q),
                  disabled: promoting,
                  children: isPromote ? 'promote' : 'evict'
                })
              ]
            }))
          : jsx('div', { className: 'px-2 py-0.5 text-[11px] text-(--ui-text-quaternary)', children: 'No .gguf files found' })
      }) : null
    ]
  })
}

function ModelCachePane({ rest }) {
  const qc = useQueryClient()
  const [recentlyPromoted, setRecentlyPromoted] = useState(new Set())
  const [refreshing, setRefreshing] = useState(false)
  const fetchingRef = useRef(false)

  const [statusData, setStatusData] = useState({})
  const [coldModels, setColdModels] = useState([])
  const [hotModels, setHotModels] = useState([])

  const restRef = useRef(rest)
  useEffect(() => {
    restRef.current = rest
  }, [rest])

  const fetchAll = useCallback(async () => {
    if (fetchingRef.current) return
    fetchingRef.current = true

    try {
      const [s, c, h] = await Promise.all([
        restRef.current('/status', { method: 'GET' }).catch(() => null),
        restRef.current('/cold', { method: 'GET' }).catch(() => null),
        restRef.current('/hot', { method: 'GET' }).catch(() => null)
      ])

      const coldList = (c && c.models) ? c.models : []
      const hotList = (h && h.models) ? h.models : []
      // Normalize cold shape to match hot (quants + quant_sizes)
      const normalizedCold = coldList.map(m => ({
        ...m,
        quants: m.quants || m.ggufs || [],
        quant_sizes: m.quant_sizes || {},
      }))

      const uniqueCold = Array.from(
        new Map(normalizedCold.filter(m => m && m.dir).map(m => [m.dir, m])).values()
      )
      const uniqueHot = Array.from(
        new Map(hotList.filter(m => m && m.dir).map(m => [m.dir, m])).values()
      )

      setStatusData(s || {})
      setColdModels(uniqueCold)
      setHotModels(uniqueHot)
    } catch (e) {
      console.error("Failed to fetch cache data", e)
    } finally {
      fetchingRef.current = false
    }
  }, [])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const promoteMut = useMutation({
    mutationFn: (arg) => {
      const { model, quant } = (typeof arg === 'string') ? { model: arg } : arg
      return restRef.current('/promote', { method: 'POST', body: { model, quant } })
    },
    onSuccess: (data, dir) => {
      if (data && data.ok) {
        setRecentlyPromoted(prev => new Set([...prev, dir]))
        fetchAll()
      }
    },
  })

  const evictMut = useMutation({
    mutationFn: ({ model, quant }) => restRef.current('/evict', { method: 'POST', body: { model, quant } }),
    onSuccess: (data) => {
      if (data && data.ok) {
        fetchAll()
      }
    },
    onError: (err) => {
      console.error('Evict failed:', err)
    },
  })

  const handleRefresh = async () => {
    setRefreshing(true)
    promoteMut.reset()
    evictMut.reset()
    await fetchAll()
    setTimeout(() => setRefreshing(false), 800)
  }

  const promoting = evictMut.isPending || promoteMut.isPending

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 p-3 text-sm overflow-auto',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between text-xs text-(--ui-text-tertiary)',
        children: [
          jsx('span', { children: `Cold: ${statusData.cold_size || '?'} | Hot: ${statusData.hot_size || '?'}` }),
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx('span', { children: `Free: ${statusData.cache_free || '?'} (${statusData.cache_pct || '?'})` }),
              jsx('button', {
                className: `w-5 h-5 flex items-center justify-center rounded-full text-(--ui-text-tertiary) hover:text-(--ui-text-primary) border border-(--ui-stroke-secondary) text-[12px] leading-none ${refreshing ? 'animate-spin' : ''}`,
                onClick: handleRefresh,
                disabled: refreshing,
                children: '↻'
              }),
            ]
          }),
        ]
      }),
      promoteMut.isPending ? jsxs('div', {
        className: 'text-xs text-(--ui-text-tertiary) mt-1 px-2 flex items-center gap-1',
        children: [
          jsx('span', { className: 'animate-spin inline-block', children: '↻' }),
          jsx('span', { children: 'Promoting... (this may take a while)' }),
        ]
      }) : promoteMut.data ? jsx('div', {
        className: 'text-xs text-(--ui-text-quaternary) mt-1 px-2',
        children: promoteMut.data.output || ''
      }) : null,
      evictMut.data ? jsx('div', {
        className: 'text-xs text-(--ui-text-quaternary) mt-1 px-2',
        children: evictMut.data.output || ''
      }) : null,
      jsx('div', {
        className: 'text-xs font-medium text-(--ui-text-secondary) mt-2',
        children: `Hot (NVMe) — ${hotModels.length} models`
      }),
      ...hotModels.map(m => jsx(ModelGroup, {
        key: m.dir,
        model: m,
        action: 'evict',
        onActionQuant: (model, quant) => evictMut.mutate({ model, quant }),
        onActionAll: (model) => evictMut.mutate({ model }),
        promoting: promoting,
      })),
      jsx('div', {
        className: 'text-xs font-medium text-(--ui-text-secondary) mt-2',
        children: `Cold (Array) — ${coldModels.length} models`
      }),
      ...coldModels.map(m => jsx(ModelGroup, {
        key: m.dir,
        model: m,
        action: 'promote',
        onActionQuant: (model, quant) => promoteMut.mutate({ model, quant }),
        onActionAll: (model) => promoteMut.mutate({ model }),
        promoting: promoting,
      }))
    ]
  })
}

export default {
  id: ID,
  name: 'Model Cache',
  register(ctx) {
    ctx.i18n.register({
      en: {
        paneTitle: 'Model Cache Tier',
      }
    })

    const rest = ctx.rest.bind(ctx)

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'model cache',
      data: { placement: 'right', width: '360px' },
      render: () => jsx(ModelCachePane, { rest })
    })
  }
}
