import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 outline-none focus-visible:border-ring focus-visible:ring-ring/20 focus-visible:ring-[3px] aria-invalid:border-destructive aria-invalid:ring-destructive/20",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-xs hover:bg-primary/85 active:bg-primary/75',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 active:bg-destructive/80 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40',
        outline:
          'border border-border bg-background text-foreground shadow-xs hover:bg-accent active:bg-muted',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent active:bg-muted',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground active:bg-muted',
        link: 'h-auto text-foreground underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2 sm:h-9 has-[>svg]:px-3.5',
        sm: 'h-10 gap-1.5 px-3 text-xs sm:h-8 has-[>svg]:px-2.5',
        lg: 'h-10 px-5 text-sm has-[>svg]:px-4',
        icon: 'size-10 sm:size-9',
        'icon-sm': 'size-10 sm:size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
