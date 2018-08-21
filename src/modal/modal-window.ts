import {DOCUMENT} from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Inject,
  Input,
  NgZone,
  OnDestroy,
  OnInit,
  Output,
  ViewChild,
  ViewEncapsulation
} from '@angular/core';

import {fromEvent, Observable, Subject, zip} from 'rxjs';
import {filter, switchMap, take, takeUntil, tap} from 'rxjs/operators';

import {getFocusableBoundaryElements} from '../util/focus-trap';
import {Key} from '../util/key';
import {ModalDismissReasons} from './modal-dismiss-reasons';
import {ngbRunTransition, NgbTransitionOptions} from '../util/transition/ngbTransition';

@Component({
  selector: 'ngb-modal-window',
  host: {
    '[class]': '"modal d-block" + (windowClass ? " " + windowClass : "")',
    '[class.fade]': 'animation',
    'role': 'dialog',
    'tabindex': '-1',
    '[attr.aria-modal]': 'true',
    '[attr.aria-labelledby]': 'ariaLabelledBy',
    '[attr.aria-describedby]': 'ariaDescribedBy'
  },
  template: `
    <div #dialog [class]="'modal-dialog' + (size ? ' modal-' + size : '') + (centered ? ' modal-dialog-centered' : '') +
     (scrollable ? ' modal-dialog-scrollable' : '')" role="document">
        <div class="modal-content"><ng-content></ng-content></div>
    </div>
    `,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['./modal.scss']
})
export class NgbModalWindow implements OnInit,
    AfterViewInit, OnDestroy {
  private _closed$ = new Subject<void>();
  private _elWithFocus: Element | null = null;  // element that is focused prior to modal opening
  private _posX: number;
  private _posY: number;

  @ViewChild('dialog', {static: true}) private _dialogEl: ElementRef<HTMLElement>;

  @Input() animation: boolean;
  @Input() ariaLabelledBy: string;
  @Input() ariaDescribedBy: string;
  @Input() backdrop: boolean | string = true;
  @Input() centered: string;
  @Input() draggableSelector: string | null = null;
  @Input() keyboard = true;
  @Input() scrollable: string;
  @Input() size: string;
  @Input() windowClass: string;

  @Output('dismiss') dismissEvent = new EventEmitter();

  shown = new Subject<void>();
  hidden = new Subject<void>();

  constructor(
      @Inject(DOCUMENT) private _document: any, private _elRef: ElementRef<HTMLElement>, private _zone: NgZone) {}

  dismiss(reason): void { this.dismissEvent.emit(reason); }

  ngOnInit() { this._elWithFocus = this._document.activeElement; }

  ngAfterViewInit() { this._show(); }

  ngOnDestroy() { this._disableEventHandling(); }

  hide(): Observable<any> {
    const {nativeElement} = this._elRef;
    const context: NgbTransitionOptions<any> = {animation: this.animation, runningTransition: 'stop'};

    const windowTransition$ = ngbRunTransition(nativeElement, () => nativeElement.classList.remove('show'), context);
    const dialogTransition$ = ngbRunTransition(this._dialogEl.nativeElement, () => {}, context);

    const transitions$ = zip(windowTransition$, dialogTransition$);
    transitions$.subscribe(() => {
      this.hidden.next();
      this.hidden.complete();
    });

    this._disableEventHandling();
    this._restoreFocus();

    return transitions$;
  }

  private _show() {
    const {nativeElement} = this._elRef;
    const context: NgbTransitionOptions<any> = {animation: this.animation, runningTransition: 'continue'};

    const windowTransition$ = ngbRunTransition(nativeElement, () => nativeElement.classList.add('show'), context);
    const dialogTransition$ = ngbRunTransition(this._dialogEl.nativeElement, () => {}, context);

    zip(windowTransition$, dialogTransition$).subscribe(() => {
      this.shown.next();
      this.shown.complete();
    });

    this._enableEventHandling();
    this._setFocus();
  }

  private _enableEventHandling() {
    const {nativeElement} = this._elRef;
    this._zone.runOutsideAngular(() => {
      fromEvent<KeyboardEvent>(nativeElement, 'keydown')
          .pipe(
              takeUntil(this._closed$),
              // tslint:disable-next-line:deprecation
              filter(e => e.which === Key.Escape))
          .subscribe(event => {
            if (this.keyboard) {
              requestAnimationFrame(() => {
                if (!event.defaultPrevented) {
                  this._zone.run(() => this.dismiss(ModalDismissReasons.ESC));
                }
              });
            } else if (this.backdrop === 'static') {
              this._bumpBackdrop();
            }
          });

      // We're listening to 'mousedown' and 'mouseup' to prevent modal from closing when pressing the mouse
      // inside the modal dialog and releasing it outside
      let preventClose = false;
      fromEvent<MouseEvent>(this._dialogEl.nativeElement, 'mousedown')
          .pipe(
              takeUntil(this._closed$), tap(() => preventClose = false),
              switchMap(() => fromEvent<MouseEvent>(nativeElement, 'mouseup').pipe(takeUntil(this._closed$), take(1))),
              filter(({target}) => nativeElement === target))
          .subscribe(() => { preventClose = true; });

      // We're listening to 'click' to dismiss modal on modal window click, except when:
      // 1. clicking on modal dialog itself
      // 2. closing was prevented by mousedown/up handlers
      // 3. clicking on scrollbar when the viewport is too small and modal doesn't fit (click is not triggered at all)
      fromEvent<MouseEvent>(nativeElement, 'click').pipe(takeUntil(this._closed$)).subscribe(({target}) => {
        if (nativeElement === target) {
          if (this.backdrop === 'static') {
            this._bumpBackdrop();
          } else if (this.backdrop === true && !preventClose) {
            this._zone.run(() => this.dismiss(ModalDismissReasons.BACKDROP_CLICK));
          }
        }

        preventClose = false;
      });
    });
  }

  private _disableEventHandling() { this._closed$.next(); }

  private _setFocus() {
    const {nativeElement} = this._elRef;
    if (!nativeElement.contains(document.activeElement)) {
      const autoFocusable = nativeElement.querySelector(`[ngbAutofocus]`) as HTMLElement;
      const firstFocusable = getFocusableBoundaryElements(nativeElement)[0];

      const elementToFocus = autoFocusable || firstFocusable || nativeElement;
      elementToFocus.focus();
    }

    if (this.draggableSelector) {
      const draggableArea: HTMLElement | null = this._elRef.nativeElement.querySelector(this.draggableSelector);
      if (draggableArea) {
        draggableArea.style.cursor = 'move';
        draggableArea.onmousedown = (e: MouseEvent) => {
          this.startDrag(e);
        };
      } else {
        console.warn(`Couldn't find draggableSelector (${this.draggableSelector})`)
      }
    }
  }

  private _restoreFocus() {
    const body = this._document.body;
    const elWithFocus = this._elWithFocus;

    let elementToFocus;
    if (elWithFocus && elWithFocus['focus'] && body.contains(elWithFocus)) {
      elementToFocus = elWithFocus;
    } else {
      elementToFocus = body;
    }
    this._zone.runOutsideAngular(() => {
      setTimeout(() => elementToFocus.focus());
      this._elWithFocus = null;
    });
  }

  private _bumpBackdrop() {
    if (this.backdrop === 'static') {
      ngbRunTransition(this._elRef.nativeElement, ({classList}) => {
        classList.add('modal-static');
        return () => classList.remove('modal-static');
      }, {animation: this.animation, runningTransition: 'continue'});
    }
  }

  private startDrag(e: MouseEvent) {
    const modalDialog: HTMLElement | null = this._elRef.nativeElement.querySelector('.modal-dialog');
    if (modalDialog) {
      modalDialog.style.marginTop = modalDialog.offsetTop + 'px';
      modalDialog.style.marginLeft = modalDialog.offsetLeft + 'px';
      modalDialog.style.marginBottom = '0';
      modalDialog.style.marginRight = '0';
      this._posX = e.clientX;
      this._posY = e.clientY;
      const maxMarginLeft = this._elRef.nativeElement.clientWidth - modalDialog.clientWidth;
      this._zone.runOutsideAngular(() => {
        document.onmousemove = (event) => {
          this.dragModal(event, maxMarginLeft);
        };
      });
      document.onmouseup = () => {
        document.onmouseup = null;
        document.onmousemove = null;
      };
    } else {
      console.warn(`Couldn't find .modal-dialog element`)
    }
  }

  private dragModal(e: MouseEvent, maxMarginLeft) {
    const modalDialog: HTMLElement | null = this._elRef.nativeElement.querySelector('.modal-dialog');
    if (modalDialog) {
      const deltaX = this._posX - e.clientX;
      const deltaY = this._posY - e.clientY;
      let marginTop = modalDialog.offsetTop - deltaY;
      let marginLeft = modalDialog.offsetLeft - deltaX;
      let marginBottom = window.innerHeight - modalDialog.offsetTop - modalDialog.offsetHeight + deltaY;
      let marginRight = window.innerWidth - modalDialog.offsetLeft - modalDialog.offsetWidth + deltaX;
      if (marginTop < 0) {
        marginTop = 0;
      } else if (marginBottom < 0 && window.innerHeight - modalDialog.offsetHeight >= 0) {
        marginTop = window.innerHeight - modalDialog.offsetHeight;
      } else {
        this._posY = e.clientY;
      }
      if (marginLeft < 0) {
        marginLeft = 0;
      } else if (marginRight < 0 && window.innerWidth - modalDialog.offsetWidth >= 0) {
        marginLeft = window.innerWidth - modalDialog.offsetWidth;
      } else {
        this._posX = e.clientX;
      }
      if (marginLeft > maxMarginLeft) {
        // don't resize when dragging to the right edge
        marginLeft = maxMarginLeft;
      }
      modalDialog.style.marginTop = marginTop + 'px';
      modalDialog.style.marginLeft = marginLeft + 'px';
    } else {
      console.warn(`Couldn't find .modal-dialog element`)
    }
  }

}
