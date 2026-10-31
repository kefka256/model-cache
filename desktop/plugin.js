import { cn, host, useQuery, useMutation, useQueryClient } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState } from 'react'

const ID = 'model-cache'

function SpaceBar({ used, total }) {
  return jsxs('div', {
    className: 'flex items-center gap-2 text-xs text-(--ui-text-tertiary)',
    children: [
      jsx('span', { children: `Cache: ${used} / ${total}` }),
    ]
  })
}

function ModelRow({ model, onPromote, onEvict, isHot, recentlyPromoted }) {
  const isNew = isHot && recentlyPromoted && recentlyPromoted.has(model.dir)
  return jsxs('div', {
    className: 'flex items-center justify-between gap-2 px-2 py-1 text-xs hover:bg-(--chrome-action-hover)',
    children: [
      jsxs('div', {
        className: 'flex-1 truncate',
        children: [
          jsx('span', { className: 'font-medium', children: model.name }),
          isNew ? jsx('span', { className: 'ml-1 text-green-400 text-[10px]', children: '★ NEW' }) : null,
          jsx('span', { className: 'ml-2 text-(--ui-text-quaternary)', children: model.size }),
        ]
      }),
      isHot
        ? jsx('button', {
            className: 'px-2 py-0.5 rounded text-(--ui-text-tertiary) hover:text-red-400',
            onClick: () => onEvict(model.dir),
            children: 'evict'
          })
        : jsx('button', {
            className: 'px-2 py-0.5 rounded text-(--ui-text-tertiary) hover:text-green-400',
            onClick: () => onPromote(model.dir),
            children: 'promote'
          })
    ]
  })
}

function ModelCachePane({ rest }) {
  const qc = useQueryClient()
  const [recentlyPromoted, setRecentlyPromoted] = useState(new Set())
  const [refreshing, setRefreshing] = useState(false)

  const status = useQuery({
    queryKey: ['mc-status'],
    queryFn: () => rest('/status', { method: 'GET' }),
    refetchInterval: 10000,
  })

  const cold = useQuery({
    queryKey: ['mc-cold'],
    queryFn: () => rest('/cold', { method: 'GET' }),
    refetchInterval: 30000,
  })

  const hot = useQuery({
    queryKey: ['mc-hot'],
    queryFn: () => rest('/hot', { method: 'GET' }),
    refetchInterval: 30000,
  })

  const promoteMut = useMutation({
    mutationFn: (dir) => rest('/promote', { method: 'POST', body: { model: dir } }),
    onSuccess: (data, dir) => {
      setRecentlyPromoted(prev => new Set([...prev, dir]))
      qc.invalidateQueries({ queryKey: ['mc-hot'] })
      qc.invalidateQueries({ queryKey: ['mc-cold'] })
      qc.invalidateQueries({ queryKey: ['mc-status'] })
    },
  })

  const evictMut = useMutation({
    mutationFn: (dir) => rest('/evict', { method: 'POST', body: { model: dir } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['mc-hot'] }); qc.invalidateQueries({ queryKey: ['mc-cold'] }); qc.invalidateQueries({ queryKey: ['mc-status'] }) },
  })

  const handleRefresh = async () => {
    setRefreshing(true)
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['mc-status'] }),
      qc.invalidateQueries({ queryKey: ['mc-cold'] }),
      qc.invalidateQueries({ queryKey: ['mc-hot'] }),
    ])
    setTimeout(() => setRefreshing(false), 800)
  }

  const statusData = status.data || {}
  const coldModels = cold.data?.models || []
  const hotModels = hot.data?.models || []

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 p-3 text-sm overflow-auto',
    children: [
      // Status bar with refresh button
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
      // Promote status
      promoteMut.data ? jsx('div', {
        className: 'text-xs text-(--ui-text-quaternary) mt-1 px-2',
        children: promoteMut.data.output || ''
      }) : null,
      // Evict status
      evictMut.data ? jsx('div', {
        className: 'text-xs text-(--ui-text-quaternary) mt-1 px-2',
        children: evictMut.data.output || ''
      }) : null,
      // Hot cache
      jsx('div', {
        className: 'text-xs font-medium text-(--ui-text-secondary) mt-2',
        children: `Hot (NVMe) — ${hotModels.length} models`
      }),
      ...hotModels.map(m => jsx(ModelRow, {
        key: m.dir,
        model: m,
        isHot: true,
        recentlyPromoted,
        onEvict: (dir) => evictMut.mutate(dir),
      })),
      // Cold storage
      jsx('div', {
        className: 'text-xs font-medium text-(--ui-text-secondary) mt-2',
        children: `Cold (Array) — ${coldModels.length} models`
      }),
      ...coldModels.map(m => jsx(ModelRow, {
        key: m.dir,
        model: m,
        isHot: false,
        onPromote: (dir) => promoteMut.mutate(dir),
      })),
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
      data: { placement: 'right', width: '320px' },
      render: () => jsx(ModelCachePane, { rest })
    })
  }
}
