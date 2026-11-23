// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '@/components/ui/alert-dialog';

afterEach(() => cleanup());
const open = (actionProps = {}) => render(
  <AlertDialog open>
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>Tem certeza?</AlertDialogTitle><AlertDialogDescription>Descrição</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction {...actionProps}>Confirmar</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>,
);

describe('AlertDialogAction — vermelho suave nas ações destrutivas (opção B, 23/11/2026)', () => {
  it('destructive: fundo translúcido vermelho, texto e contorno no tom de perda do painel — e NÃO o azul do botão normal', () => {
    open({ destructive: true });
    const cls = screen.getByRole('button', { name: 'Confirmar' }).className;
    expect(cls).toMatch(/bg-\[#e06a5b\]\/15/);
    expect(cls).toMatch(/text-\[#e06a5b\]/);
    expect(cls).toMatch(/border-\[#e06a5b\]\/45/);
    expect(cls).not.toMatch(/\bbg-primary\b/); // o fundo normal foi substituído (tailwind-merge)
  });

  it('sem a prop é o botão de sempre (azul primário), sem nenhum vermelho', () => {
    open();
    const cls = screen.getByRole('button', { name: 'Confirmar' }).className;
    expect(cls).toMatch(/\bbg-primary\b/);
    expect(cls).not.toMatch(/e06a5b/);
  });

  it('o atributo destructive não vaza para o DOM', () => {
    open({ destructive: true });
    expect(screen.getByRole('button', { name: 'Confirmar' }).hasAttribute('destructive')).toBe(false);
  });
});
